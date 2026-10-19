// Checks readings from the video so a bad OCR result can't jump the clock or the score.
// A reading is only accepted when it makes sense given the last accepted one.

const toSeconds = (text) => {
  const m = /^(\d{1,2}):(\d{2})(?:\.(\d))?$/.exec(text || '');
  if (!m || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
};

export const MAX_SCORE = 199;

export class ReadingGuard {
  constructor() {
    this.reset();
  }

  reset() {
    this.clock = null; // { secs, text, t }
    this.direction = 0; // 1 if the clock counts up, -1 if it counts down
    this.clockPending = null;
    this.scores = {}; // slot -> { value, confirmed }
    this.scorePending = {};
    this.lastT = null;
  }

  // forget the scores but keep the clock, used when someone reads the scoreboard by hand
  resetScores() {
    this.scores = {};
    this.scorePending = {};
  }

  // call with the video time before each reading, a jump in time starts everything over
  // returns true when the time jumped and the state was cleared
  seen(t) {
    const jumped = this.lastT !== null && (t < this.lastT - 0.5 || t - this.lastT > 12);
    if (jumped) this.reset();
    this.lastT = t;
    return jumped;
  }

  // returns the accepted clock text, or null if there is none yet
  acceptClock(text, t, speed = 1) {
    const secs = toSeconds(text);
    if (secs === null) return this.clock ? this.clock.text : null;
    const old = this.clock;

    if (!old) {
      this.clock = { secs, text, t };
      return text;
    }
    if (secs === old.secs) {
      old.t = t;
      return old.text;
    }

    // the clock can't run faster than the video, and it keeps going the same way
    const delta = secs - old.secs;
    const allowed = Math.max(0, t - old.t) * speed + 3;
    const wrongWay = this.direction !== 0 && Math.abs(delta) > 2 && Math.sign(delta) !== this.direction;
    if (Math.abs(delta) <= allowed && !wrongWay) {
      if (Math.abs(delta) >= 2) this.direction = Math.sign(delta);
      this.clock = { secs, text, t };
      this.clockPending = null;
      return text;
    }

    // doesn't fit: only believe it if the next readings agree with each other
    const p = this.clockPending;
    const follows = p && Math.abs(secs - p.secs) <= Math.max(0, t - p.t) * speed + 3;
    this.clockPending = { secs, t, count: follows ? p.count + 1 : 1 };
    if (this.clockPending.count >= 3) {
      this.clock = { secs, text, t };
      this.clockPending = null;
      this.direction = 0;
      return text;
    }
    return old.text;
  }

  // slot is any key (like 0 and 1 for the two teams). returns the accepted value or null
  acceptScore(slot, value) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SCORE) {
      return this.scores[slot] ? this.scores[slot].value : null;
    }
    const old = this.scores[slot];
    if (!old) {
      this.scores[slot] = { value, confirmed: false };
      return value;
    }
    if (value === old.value) {
      old.confirmed = true;
      this.scorePending[slot] = null;
      return old.value;
    }
    if (!old.confirmed) {
      this.scores[slot] = { value, confirmed: false };
      return value;
    }

    // a score only goes up, by a small amount, and has to be seen twice in a row
    const normalStep = value > old.value && value - old.value <= 3;
    const need = normalStep ? 2 : 4;
    const pending = this.scorePending[slot] && this.scorePending[slot].value === value ? this.scorePending[slot] : { value, count: 0 };
    pending.count += 1;
    this.scorePending[slot] = pending;
    if (pending.count >= need) {
      this.scores[slot] = { value, confirmed: true };
      this.scorePending[slot] = null;
      return value;
    }
    return old.value;
  }
}
