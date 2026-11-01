// STUB — replaced by the world module.
import type { ReactorSimApi } from '../sim/types';
export interface WorldApi { update(dt: number): void; render(): void; lockPointer(): void; unlockPointer(): void }
export function createWorld(_container: HTMLElement, _sim: ReactorSimApi): WorldApi {
  return { update() {}, render() {}, lockPointer() {}, unlockPointer() {} };
}
