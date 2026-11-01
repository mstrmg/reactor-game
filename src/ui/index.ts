// STUB — replaced by the ui module.
import type { ReactorSimApi } from '../sim/types';
export interface UIApi { update(dt: number): void }
export function createUI(_root: HTMLElement, _sim: ReactorSimApi): UIApi { return { update() {} }; }
