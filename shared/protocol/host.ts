/** Host controls are independent of conversation handles and surface rendering. */
export type WebHostOperation = {
  id: string;
  action: "restart" | "deploy";
  phase: "starting" | "validating" | "restarting" | "finished";
  message: string;
};
export type WebHostStatus = {
  instanceId: string;
  startedAt: string;
  available: boolean;
  runningCommit: string | null;
  checkout: { deployedCommit: string; matchingRemoteRefs: string[]; deploymentInProgress: boolean } | null;
  operation: WebHostOperation | null;
};
export type WebHostAction = { requestId: string; action: "restart" | "deploy"; branch?: string };
