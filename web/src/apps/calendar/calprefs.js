// Calendar settings (the same rules as server/src/calprefs.js): how long a new event lasts.
export const LENGTHS = [15, 20, 30, 45, 60, 90, 120];
export const DEFAULT_CAL_PREFS = { length: 60, speedy: false, reminders: [10] };
/** Minutes a new event lasts: the length, less 5 (under an hour) or 10 minutes with speedy meetings. */
export const newEventMinutes = ({ length, speedy } = DEFAULT_CAL_PREFS) => (speedy && length >= 30 ? length - (length >= 60 ? 10 : 5) : length);
export const lengthLabel = (m) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`);
