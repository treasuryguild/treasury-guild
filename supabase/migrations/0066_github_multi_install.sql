-- A community may connect several GitHub App installations (one per GitHub
-- organisation or account), so workgroups fed from different organisations
-- can be paid from the same treasury. The tables already key installations
-- by installation_id with community_id as a plain FK (0004); these indexes
-- serve the per-community and per-installation lookups the settings and
-- sync code now makes. No uniqueness, RLS or column changes.

create index github_installations_community_idx on public.github_installations (community_id);
create index github_repos_installation_idx on public.github_repos (installation_id);
create index github_project_links_installation_idx on public.github_project_links (installation_id);
