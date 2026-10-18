export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new Error("messageId e consumerName são obrigatórios");
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      return;
    }
    this._processedAt = at;
  }

  toState(): InboxMessageState {
    return {
      messageId: this.messageId,
      consumerName: this.consumerName,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this._processedAt,
    };
  }
}
