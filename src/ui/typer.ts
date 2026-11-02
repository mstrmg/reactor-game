/** Typewriter text with per-character voice blips (Animal Crossing style). */
import { voice, type Speaker } from '../audio/voice';

const CPS = 34; // characters per second

/** Types text into an element, one character at a time, with voice blips. */
export class Typer {
  text = '';
  i = 0;
  acc = 0;
  done = true;
  who: Speaker = 'dale';
  private question = false;
  constructor(public el: HTMLElement) {}
  start(text: string, who: Speaker) {
    this.text = text;
    this.who = who;
    this.i = 0;
    this.acc = 0;
    this.done = false;
    this.question = /\?\s*$/.test(text);
    this.el.textContent = '';
  }
  finish() {
    this.i = this.text.length;
    this.el.textContent = this.text;
    this.done = true;
  }
  update(dt: number) {
    if (this.done) return;
    this.acc += dt * CPS;
    const start = this.i;
    while (this.acc >= 1 && this.i < this.text.length) {
      const ch = this.text[this.i++];
      this.acc -= 1;
      if (ch === '.' || ch === '!' || ch === '?') this.acc -= 7;
      else if (ch === ',' || ch === '—' || ch === ';' || ch === ':') this.acc -= 3;
      if (this.who !== 'sys') voice.babble(ch, this.who, this.question && this.text.length - this.i < 12);
    }
    if (this.i !== start) this.el.textContent = this.text.slice(0, this.i);
    if (this.i >= this.text.length) this.done = true;
  }
}

