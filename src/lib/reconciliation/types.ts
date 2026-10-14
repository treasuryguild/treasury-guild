// Wire types shared by the reconcile API routes and the Reconcile page.

export interface MatchSuggestion {
  payoutId: string;
  taskId: string;
  taskTitle: string;
  contributorWallet: string;
  unit: string;
  amount: string;
  score: number;
}
