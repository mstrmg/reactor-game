// STUB — replaced by the audio module.
import type { ReactorSimApi } from '../sim/types';
export interface AudioApi { start(): Promise<void>; update(dt: number): void }
export function createAudio(_sim: ReactorSimApi): AudioApi { return { async start() {}, update() {} }; }
