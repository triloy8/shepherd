export type SignalSubject = {
  type: string;
  id: string;
};

export type SignalEnvelope<TPayload = unknown> = {
  kind: string;
  version: number;
  subject?: SignalSubject;
  payload: TPayload;
};
