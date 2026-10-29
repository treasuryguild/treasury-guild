// GraphQL helpers for GitHub Projects v2. projects_v2_item webhook payloads
// are sparse (node ids only), so item details need a follow-up query. The
// cron sweep uses the repo-wide query so it sees project columns and custom
// number fields, which REST issue endpoints never expose. The writes are
// addProjectItemByContentId (in-app create), setProjectItemStatus (post-payment
// move to the "Paid" column, and in-app status moves),
// setProjectItemNumberFields (in-app bounty edits) and
// ensureProjectNumberField (create a bounty NUMBER field from a wallet token);
// they need the App's Projects permission at read & write.
import "server-only";

import { installationOctokit } from "./app";
import type { LiveBoardItem, LiveProjectBoard } from "@/lib/boardTypes";
import {
  extractProjectFields,
  matchStatusOption,
  type ProjectFieldValues,
  type RawFieldValueNode,
} from "./projectFields";

export {
  extractProjectFields,
  type ProjectFieldValues,
  type RawFieldValueNode,
} from "./projectFields";

const FIELD_VALUES_FRAGMENT = `
fieldValues(first: 30) {
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue {
      name
      field { ... on ProjectV2FieldCommon { name } }
    }
    ... on ProjectV2ItemFieldNumberValue {
      number
      field { ... on ProjectV2FieldCommon { name } }
    }
  }
}`;

export interface ProjectItemDetails {
  itemNodeId: string;
  projectId: string | null;
  fields: ProjectFieldValues;
  issue: {
    nodeId: string;
    number: number;
    title: string;
    body: string | null;
    url: string;
    repoId: number;
    labels: string[];
    assigneeLogins: string[];
    /** Login + immutable GitHub user id for sync / OAuth backfill. */
    assignees: { login: string; id: number }[];
  } | null;
}

function githubAssignees(
  nodes: { login: string; databaseId?: number | null }[] | undefined,
): { login: string; id: number }[] {
  return (nodes ?? [])
    .filter((a): a is { login: string; databaseId: number } =>
      !!a.login && typeof a.databaseId === "number")
    .map((a) => ({ login: a.login, id: a.databaseId }));
}

const ITEM_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      project { id }
      ${FIELD_VALUES_FRAGMENT}
      content {
        ... on Issue {
          id
          number
          title
          body
          url
          repository { databaseId }
          labels(first: 50) { nodes { name } }
          assignees(first: 10) { nodes { login databaseId } }
        }
      }
    }
  }
}`;

export async function fetchProjectItem(
  installationId: number,
  itemNodeId: string,
): Promise<ProjectItemDetails | null> {
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(ITEM_QUERY, { id: itemNodeId })) as {
    node: {
      id: string;
      project: { id: string } | null;
      fieldValues: { nodes: RawFieldValueNode[] } | null;
      content: {
        id?: string;
        number?: number;
        title?: string;
        body?: string | null;
        url?: string;
        repository?: { databaseId: number };
        labels?: { nodes: { name: string }[] };
        assignees?: { nodes: { login: string; databaseId?: number | null }[] };
      } | null;
    } | null;
  };
  const node = res.node;
  if (!node) return null;

  const content = node.content;
  const assignees = githubAssignees(content?.assignees?.nodes);
  const issue =
    content?.number && content.repository
      ? {
          nodeId: content.id!,
          number: content.number,
          title: content.title ?? "",
          body: content.body ?? null,
          url: content.url ?? "",
          repoId: content.repository.databaseId,
          labels: (content.labels?.nodes ?? []).map((l) => l.name),
          assigneeLogins: assignees.map((a) => a.login),
          assignees,
        }
      : null;

  return {
    itemNodeId: node.id,
    projectId: node.project?.id ?? null,
    fields: extractProjectFields(node.fieldValues?.nodes ?? []),
    issue,
  };
}

export interface ImportedIssue {
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  labels: string[];
  state: string;
  assigneeLogins: string[];
  assignees: { login: string; id: number }[];
  projectItems: {
    itemNodeId: string;
    projectId: string | null;
    fields: ProjectFieldValues;
  }[];
}

const REPO_ISSUES_QUERY = `
query($owner: String!, $name: String!, $label: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $cursor, labels: [$label], states: [OPEN, CLOSED]) {
      nodes {
        id
        number
        title
        body
        url
        state
        labels(first: 50) { nodes { name } }
        assignees(first: 10) { nodes { login databaseId } }
        projectItems(first: 10) {
          nodes {
            id
            project { id }
            ${FIELD_VALUES_FRAGMENT}
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const MAX_ISSUE_PAGES = 20; // 1000 labeled issues per sweep is plenty

/**
 * All issues carrying the given label, with their Project v2 items' Status
 * and number fields. Server-side label filtering keeps volume small.
 */
export async function fetchRepoIssuesWithProjectFields(
  installationId: number,
  owner: string,
  name: string,
  label: string,
): Promise<ImportedIssue[]> {
  const octokit = await installationOctokit(installationId);
  const out: ImportedIssue[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const res = (await octokit.graphql(REPO_ISSUES_QUERY, {
      owner,
      name,
      label,
      cursor,
    })) as {
      repository: {
        issues: {
          nodes: {
            id: string;
            number: number;
            title: string;
            body: string | null;
            url: string;
            state: string;
            labels: { nodes: { name: string }[] } | null;
            assignees: { nodes: { login: string; databaseId?: number | null }[] } | null;
            projectItems: {
              nodes: {
                id: string;
                project: { id: string } | null;
                fieldValues: { nodes: RawFieldValueNode[] } | null;
              }[];
            } | null;
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
    const issues = res.repository?.issues;
    if (!issues) break;

    for (const n of issues.nodes) {
      const assignees = githubAssignees(n.assignees?.nodes ?? undefined);
      out.push({
        nodeId: n.id,
        number: n.number,
        title: n.title,
        body: n.body,
        url: n.url,
        labels: (n.labels?.nodes ?? []).map((l) => l.name),
        state: n.state,
        assigneeLogins: assignees.map((a) => a.login),
        assignees,
        projectItems: (n.projectItems?.nodes ?? []).map((item) => ({
          itemNodeId: item.id,
          projectId: item.project?.id ?? null,
          fields: extractProjectFields(item.fieldValues?.nodes ?? []),
        })),
      });
    }

    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Live full-board view: the whole ProjectV2 by node id. The Status field's
// options come back in GitHub's board column order — that ordering (and the
// existence of empty columns) is unobtainable from the issue-first queries.

const PROJECT_BOARD_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      title
      url
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { options { id name } }
      }
      items(first: 50, after: $cursor) {
        nodes {
          id
          ${FIELD_VALUES_FRAGMENT}
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              state
              labels(first: 20) { nodes { name } }
              assignees(first: 10) { nodes { login databaseId } }
              repository { databaseId nameWithOwner }
            }
            ... on DraftIssue { title }
            ... on PullRequest { id number title url }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const MAX_BOARD_PAGES = 20; // 1000 items per board view is plenty

interface RawBoardContent {
  __typename?: string;
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  labels?: { nodes: { name: string }[] };
  assignees?: { nodes: { login: string }[] };
  repository?: { databaseId: number; nameWithOwner: string };
}

function classifyContent(
  content: RawBoardContent | null,
): LiveBoardItem["kind"] {
  switch (content?.__typename) {
    case "Issue":
      return "issue";
    case "DraftIssue":
      return "draft";
    case "PullRequest":
      return "pull_request";
    default:
      return "unknown";
  }
}

/**
 * The full live board for one ProjectV2. Returns null when the node id no
 * longer resolves to a readable ProjectV2 (deleted, or permissions) so the
 * caller can drop the stale link.
 */
export async function fetchProjectBoard(
  installationId: number,
  projectId: string,
): Promise<LiveProjectBoard | null> {
  const octokit = await installationOctokit(installationId);
  let title = "";
  let url = "";
  let statusOptions: string[] = [];
  const items: LiveBoardItem[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_BOARD_PAGES; page++) {
    const res = (await octokit.graphql(PROJECT_BOARD_QUERY, {
      projectId,
      cursor,
    })) as {
      node: {
        title?: string;
        url?: string;
        field?: { options?: { id: string; name: string }[] } | null;
        items?: {
          nodes: {
            id: string;
            fieldValues: { nodes: RawFieldValueNode[] } | null;
            content: RawBoardContent | null;
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    };
    const node = res.node;
    // A non-ProjectV2 node matches no inline fragment: all fields undefined.
    if (!node || node.title === undefined) return null;

    if (page === 0) {
      title = node.title ?? "";
      url = node.url ?? "";
      statusOptions = (node.field?.options ?? []).map((o) => o.name);
    }

    for (const raw of node.items?.nodes ?? []) {
      const kind = classifyContent(raw.content);
      const content = raw.content;
      const fields = extractProjectFields(raw.fieldValues?.nodes ?? []);
      items.push({
        itemNodeId: raw.id,
        kind,
        contentNodeId: kind === "issue" ? (content?.id ?? null) : null,
        number: content?.number ?? null,
        title: content?.title ?? "(untitled)",
        url: content?.url ?? null,
        state: content?.state ?? null,
        status: fields.status,
        numbers: fields.numbers,
        labels: (content?.labels?.nodes ?? []).map((l) => l.name),
        assigneeLogins: (content?.assignees?.nodes ?? []).map((a) => a.login),
        repoId: content?.repository?.databaseId ?? null,
        repoFullName: content?.repository?.nameWithOwner ?? null,
      });
    }

    const pageInfo = node.items?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    if (page === MAX_BOARD_PAGES - 1) truncated = true;
  }

  return { projectId, title, url, statusOptions, items, truncated };
}

const REPO_PROJECTS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 10) { nodes { id title closed } }
  }
}`;

// ---------------------------------------------------------------------------
// Post-payment write: move one item to a Status option (the repo's
// paid_status). Field and option ids are looked up per call — they are
// never stored, so a renamed or recreated Status field cannot go stale.

const ITEM_STATUS_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      project {
        id
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}`;

const SET_STATUS_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;

const ADD_ITEM_MUTATION = `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

export type SetStatusResult =
  /** `status` is the option's name as GitHub spells it. */
  | { outcome: "updated" | "unchanged"; status: string }
  | { outcome: "no_item" | "no_status_field" | "no_option" };

export type AddProjectItemResult =
  | { outcome: "added"; itemNodeId: string; status: string }
  | { outcome: "no_item" | "no_status_field" | "no_option" };

/**
 * Add an issue (or other ProjectV2 content) to a project and move it to the
 * named Status column. Throws on transport/permission errors; returns
 * `no_option` / `no_status_field` / `no_item` when the status write cannot
 * land so the caller can map them to a 400.
 */
export async function addProjectItemByContentId(
  installationId: number,
  projectId: string,
  contentId: string,
  statusName: string,
): Promise<AddProjectItemResult> {
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(ADD_ITEM_MUTATION, { projectId, contentId })) as {
    addProjectV2ItemById?: { item?: { id?: string } | null } | null;
  };
  const itemNodeId = res.addProjectV2ItemById?.item?.id;
  if (!itemNodeId) {
    throw new Error("GitHub addProjectV2ItemById returned no item id");
  }
  const moved = await setProjectItemStatus(installationId, itemNodeId, statusName);
  if (moved.outcome === "updated" || moved.outcome === "unchanged") {
    return { outcome: "added", itemNodeId, status: moved.status };
  }
  return { outcome: moved.outcome };
}

/**
 * Move a project item to the Status option named `statusName` (matched
 * case-insensitively). Never creates options: when the project has no such
 * column the item stays put and the caller decides what to log. Throws on
 * transport/permission errors (e.g. FORBIDDEN while the App's Projects
 * permission is still read-only).
 */
export async function setProjectItemStatus(
  installationId: number,
  itemNodeId: string,
  statusName: string,
): Promise<SetStatusResult> {
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(ITEM_STATUS_QUERY, { id: itemNodeId })) as {
    node: {
      id?: string;
      project?: {
        id: string;
        field: { id?: string; options?: { id: string; name: string }[] } | null;
      } | null;
      fieldValueByName?: { name?: string } | null;
    } | null;
  };
  const node = res.node;
  if (!node?.id || !node.project) return { outcome: "no_item" };
  const field = node.project.field;
  if (!field?.id || !field.options) return { outcome: "no_status_field" };
  const option = matchStatusOption(field.options, statusName);
  if (!option) return { outcome: "no_option" };
  if (node.fieldValueByName?.name === option.name) {
    return { outcome: "unchanged", status: option.name };
  }
  await octokit.graphql(SET_STATUS_MUTATION, {
    projectId: node.project.id,
    itemId: node.id,
    fieldId: field.id,
    optionId: option.id,
  });
  return { outcome: "updated", status: option.name };
}

const ITEM_FIELDS_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      id
      project {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }
}`;

type ItemProjectField = { id?: string; name?: string; dataType?: string };

/** Number-field names on the project that owns this item (bounty picker). */
export async function listProjectNumberFieldNames(
  installationId: number,
  itemNodeId: string,
): Promise<string[]> {
  const fields = await loadItemProjectNumberFields(installationId, itemNodeId);
  return fields.map((f) => f.name);
}

async function loadItemProjectNumberFields(
  installationId: number,
  itemNodeId: string,
): Promise<{ id: string; name: string }[]> {
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(ITEM_FIELDS_QUERY, { id: itemNodeId })) as {
    node: {
      id?: string;
      project?: {
        id: string;
        fields?: { nodes?: (ItemProjectField | null)[] | null } | null;
      } | null;
    } | null;
  };
  const out: { id: string; name: string }[] = [];
  for (const field of res.node?.project?.fields?.nodes ?? []) {
    if (!field?.id || !field.name) continue;
    if (field.dataType !== "NUMBER") continue;
    out.push({ id: field.id, name: field.name });
  }
  return out;
}

const SET_NUMBER_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $number: Float!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { number: $number }
  }) { projectV2Item { id } }
}`;

const CLEAR_FIELD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId
  }) { projectV2Item { id } }
}`;

export interface SetNumberFieldsResult {
  /** Field names written with a new value, in request order. */
  updated: string[];
  /** Field names cleared (a null value), in request order. */
  cleared: string[];
  /** Field names the project has no such field for; nothing was written for them. */
  missing: string[];
}

/**
 * Write an item's number fields by field name (the bounty edit from the app).
 * Field ids are looked up per call, never stored. A null value clears the
 * field. Fields the project does not have are reported in `missing` instead
 * of failing the whole edit — create fields explicitly via
 * `ensureProjectNumberField` (POST /api/github/project-field).
 */
export async function setProjectItemNumberFields(
  installationId: number,
  itemNodeId: string,
  values: Record<string, number | null>,
): Promise<SetNumberFieldsResult> {
  const result: SetNumberFieldsResult = { updated: [], cleared: [], missing: [] };
  const names = Object.keys(values);
  if (names.length === 0) return result;
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(ITEM_FIELDS_QUERY, { id: itemNodeId })) as {
    node: {
      id?: string;
      project?: {
        id: string;
        fields?: { nodes?: (ItemProjectField | null)[] | null } | null;
      } | null;
    } | null;
  };
  const node = res.node;
  if (!node?.id || !node.project) {
    return { ...result, missing: names };
  }
  const byName = new Map<string, string>();
  for (const field of node.project.fields?.nodes ?? []) {
    if (!field?.id || !field.name || field.dataType !== "NUMBER") continue;
    byName.set(field.name.toLowerCase(), field.id);
  }
  for (const name of names) {
    const fieldId = byName.get(name.toLowerCase());
    if (!fieldId) {
      result.missing.push(name);
      continue;
    }
    const value = values[name];
    if (value === null || value === undefined) {
      await octokit.graphql(CLEAR_FIELD_MUTATION, {
        projectId: node.project.id,
        itemId: node.id,
        fieldId,
      });
      result.cleared.push(name);
    } else {
      await octokit.graphql(SET_NUMBER_MUTATION, {
        projectId: node.project.id,
        itemId: node.id,
        fieldId,
        number: value,
      });
      result.updated.push(name);
    }
  }
  return result;
}

/** Projects a repo belongs to — discovery fallback when no link is stored. */
export async function fetchRepoProjects(
  installationId: number,
  owner: string,
  name: string,
): Promise<{ id: string; title: string; closed: boolean }[]> {
  const octokit = await installationOctokit(installationId);
  const res = (await octokit.graphql(REPO_PROJECTS_QUERY, { owner, name })) as {
    repository: {
      projectsV2: { nodes: { id: string; title: string; closed: boolean }[] };
    } | null;
  };
  return res.repository?.projectsV2.nodes ?? [];
}

const PROJECT_FIELDS_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
        }
      }
    }
  }
}`;

const CREATE_NUMBER_FIELD_MUTATION = `
mutation($projectId: ID!, $name: String!) {
  createProjectV2Field(input: {
    projectId: $projectId, dataType: NUMBER, name: $name
  }) {
    projectV2Field {
      ... on ProjectV2Field {
        id
        name
        dataType
      }
    }
  }
}`;

export interface EnsureNumberFieldResult {
  /** Canonical field name on the project (existing spelling when reused). */
  fieldName: string;
  /** False when a NUMBER field with this name already existed. */
  created: boolean;
}

/**
 * Ensure the project has a NUMBER field with this name (bounty create flow).
 * Reuses an existing field when the name matches case-insensitively.
 */
export async function ensureProjectNumberField(
  installationId: number,
  projectNodeId: string,
  name: string,
): Promise<EnsureNumberFieldResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Field name is required");
  const octokit = await installationOctokit(installationId);
  const listed = (await octokit.graphql(PROJECT_FIELDS_QUERY, { id: projectNodeId })) as {
    node: {
      id?: string;
      fields?: { nodes?: (ItemProjectField | null)[] | null } | null;
    } | null;
  };
  if (!listed.node?.id) throw new Error("GitHub project not found");
  const want = trimmed.toLowerCase();
  for (const field of listed.node.fields?.nodes ?? []) {
    if (!field?.name || field.dataType !== "NUMBER") continue;
    if (field.name.toLowerCase() === want) {
      return { fieldName: field.name, created: false };
    }
  }
  const created = (await octokit.graphql(CREATE_NUMBER_FIELD_MUTATION, {
    projectId: projectNodeId,
    name: trimmed,
  })) as {
    createProjectV2Field?: {
      projectV2Field?: { id?: string; name?: string; dataType?: string } | null;
    } | null;
  };
  const field = created.createProjectV2Field?.projectV2Field;
  if (!field?.name || field.dataType !== "NUMBER") {
    throw new Error("GitHub did not return the new number field");
  }
  return { fieldName: field.name, created: true };
}
