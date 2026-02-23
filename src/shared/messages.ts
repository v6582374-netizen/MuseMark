export const PROTOCOL_VERSION = 1;

export interface MessageEnvelope<TPayload = unknown> {
  protocolVersion: number;
  type: string;
  payload?: TPayload;
}

export interface RuntimeResponse<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: string;
}

export const QUICKDOCK_MESSAGE_TYPES = {
  getState: "quickDock/getState",
  listEntries: "quickDock/listEntries",
  controlData: "quickDock/controlData",
  open: "quickDock/open",
  pin: "quickDock/pin",
  unpin: "quickDock/unpin",
  reorderPinned: "quickDock/reorderPinned",
  dismiss: "quickDock/dismiss",
  saveCurrent: "quickDock/saveCurrent",
  updateLayout: "quickDock/updateLayout"
} as const;
