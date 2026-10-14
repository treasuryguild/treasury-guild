import { PageTitle } from "@/components/ui";
import { CommunityDirectory } from "@/components/community/CommunityDirectory";

// Public community discovery. Works logged out too: the anon key reads the
// public rows under the visibility-aware RLS policy.

export default function DiscoverPage() {
  return (
    <div>
      <PageTitle>Discover communities</PageTitle>
      <CommunityDirectory />
    </div>
  );
}
