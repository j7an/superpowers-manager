export interface SafetyErrorOptions<TDetails> {
  readonly cause?: unknown;
  readonly details?: TDetails;
}

export class SafetyError<TDetails = undefined> extends Error {
  readonly module: string;
  readonly details: TDetails | undefined;

  constructor(
    module: string,
    message: string,
    options: SafetyErrorOptions<TDetails> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SafetyError";
    this.module = module;
    this.details = options.details;
  }
}
