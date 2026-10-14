"use client";

// What the budget check found when the transaction was built (the
// community's spending check in warn mode), for every signer to weigh
// before signing. Nothing is recomputed here: the problems are as stored.
import { spendProblemText, type SpendProblem } from "@/lib/governance/spendCheck";
import { Card } from "@/components/ui";

export function SpendProblemsCard({ problems }: { problems: readonly SpendProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <Card className="mb-4 border-amber-500/30">
      <h3 className="mb-2 text-sm font-medium text-amber-400">Budget check</h3>
      <p className="mb-2 text-xs text-zinc-400">
        This spend did not fit the voted budgets when it was built. The community chose to warn rather than
        refuse; signing it is the signers&apos; call.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-200">
        {problems.map((p, i) => (
          <li key={i}>{spendProblemText(p)}</li>
        ))}
      </ul>
    </Card>
  );
}
