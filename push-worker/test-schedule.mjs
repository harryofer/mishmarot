// Verifies the reminder scheduling logic: right reminder, right day, exactly once.
import { dueMessages } from './worker.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ✓ ' : 'FAIL ✗ ') + name);
  if (!ok) { console.log('   want:', JSON.stringify(want)); console.log('   got :', JSON.stringify(got)); }
  ok ? pass++ : fail++;
};
const keys = rec => (t => dueMessages(rec, t).map(m => m[0]));

// shifts on the 12th and 20th of June 2026
const shiftDates = ['2026-06-12', '2026-06-20'];
const base = { shiftDates, reminders: {}, sent: {} };
const at = (date, hm) => ({ date, hm, day: +date.slice(8) });

// 1. day-before reminder fires the evening before a shift, not earlier
check('day-before: 20:00 on the 11th (shift on 12th) → fires',
  keys(base)(at('2026-06-11', '20:00')), ['before']);
check('day-before: 19:00 on the 11th → too early, silent',
  keys(base)(at('2026-06-11', '19:00')), []);
check('day-before: 20:00 on the 10th (no shift on 11th) → silent',
  keys({ ...base, reminders: { paid: false } })(at('2026-06-10', '20:00')), []);

// 2. already-sent guard
check('day-before: already sent today → silent',
  keys({ ...base, sent: { before: '2026-06-11' } })(at('2026-06-11', '21:00')), []);
check('day-before: sent yesterday → fires again today',
  keys({ ...base, sent: { before: '2026-06-10' } })(at('2026-06-11', '20:00')), ['before']);

// 3. second reminder with custom lead time
check('second reminder: 3 days before, fires on the 9th',
  keys({ ...base, reminders: { before: false, before2: true, before2Days: 3, before2Time: '09:00' } })(at('2026-06-09', '09:00')),
  ['before2']);

// 4. monthly paid reminder
check('paid: on day 10 at 12:00 → fires',
  keys({ ...base, reminders: { before: false } })(at('2026-06-10', '12:00')), ['paid']);
check('paid: on day 11 → silent (wrong day)',
  keys({ ...base, reminders: { before: false } })(at('2026-06-11', '12:00')), []);
check('paid: custom day 5 at 09:00 → fires',
  keys({ ...base, reminders: { before: false, paidDay: 5, paidTime: '09:00' } })(at('2026-06-05', '09:00')), ['paid']);

// 5. "did you arrive" fires on a shift day only
check('worked: 18:00 on a shift day → fires',
  keys({ ...base, reminders: { before: false } })(at('2026-06-12', '18:00')), ['worked']);
check('worked: 18:00 on a non-shift day → silent',
  keys({ ...base, reminders: { before: false } })(at('2026-06-13', '18:00')), []);

// 6. disabled reminders stay silent
check('all disabled → silent',
  keys({ ...base, reminders: { before: false, paid: false, worked: false } })(at('2026-06-11', '23:00')), []);

// 7. two reminders can land in the same tick
check('day-before + worked on the same evening',
  keys({ ...base, shiftDates: ['2026-06-12', '2026-06-13'], reminders: { workedTime: '20:00' } })(at('2026-06-12', '20:00')),
  ['before', 'worked']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
