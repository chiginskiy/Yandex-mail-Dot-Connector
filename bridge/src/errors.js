export class BridgeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export const fail = (status, code) => { throw new BridgeError(status, code); };
