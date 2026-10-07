export interface AudioInput {
  data: Buffer;
  filename: string;
  mimeType: string;
}

/** Swap this implementation to use a different transcription provider. */
export interface Transcriber {
  readonly name: string;
  transcribe(input: AudioInput): Promise<string>;
}
