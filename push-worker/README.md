# שרת התראות רקע — הוראות הקמה

שרת חינמי (Cloudflare Workers) ששולח התראות לטלפון גם כשהאפליקציה סגורה.
המסלול החינמי מספיק בגדול: 100,000 בקשות ליום, ואנחנו משתמשים ב-96 בלבד (בדיקה כל 15 דקות).

## מפתחות שכבר נוצרו עבורך

```
VAPID_PUBLIC  = BAz_qeVepTEtRug-tFeIRK95ZXlCnLY7SBQWEF2LjUxUjXhwH2zKkw0mynGkXxGm0jh844Q7v5udSeG1NypPTgc
VAPID_PRIVATE = YWKh2aQA5vtWI0rzgMRFbT8733XCW_66O4JAQhY5fJk
```

⚠️ ה-PRIVATE הוא סוד — הוא נשמר רק כ-secret בשרת, לא בקוד האתר.

---

## שלב 1 — חשבון Cloudflare (חינם)
1. היכנס ל-https://dash.cloudflare.com/sign-up
2. הירשם עם המייל שלך ואמת אותו. **אין צורך בכרטיס אשראי.**

## שלב 2 — התחברות מהמחשב
בתיקיית `push-worker` הרץ:
```bash
npx wrangler login
```
ייפתח דפדפן — אשר את ההרשאה.

## שלב 3 — יצירת אחסון (KV)
```bash
npx wrangler kv namespace create SUBS
```
הפקודה תחזיר שורה עם `id = "..."`.
העתק את ה-id והדבק אותו ב-`wrangler.toml` במקום `REPLACE_WITH_YOUR_KV_ID`.

## שלב 4 — הגדרת הסודות
הרץ כל פקודה והדבק את הערך כשמתבקש:
```bash
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
npx wrangler secret put VAPID_SUBJECT
```
- `VAPID_PUBLIC` / `VAPID_PRIVATE` — מהמפתחות למעלה
- `VAPID_SUBJECT` — `mailto:harryofer@gmail.com`

## שלב 5 — פריסה
```bash
npx wrangler deploy
```
בסוף תקבל כתובת כמו:
```
https://mishmarot-push.<השם-שלך>.workers.dev
```
**העתק אותה.**

## שלב 6 — חיבור באפליקציה
1. פתח את האפליקציה → **הגדרות** → **התראות ותזכורות**
2. הדבק את הכתובת בשדה **"כתובת שרת ההתראות"**
3. לחץ **"הפעל התראות רקע"** ואשר את בקשת ההתראות
4. לחץ **"שלח בדיקה"** — אמורה להופיע התראה

---

## חשוב לאייפון 🍎
התראות רקע באייפון עובדות **רק** אם האתר מותקן במסך הבית:
Safari → כפתור שיתוף → **"הוסף למסך הבית"** → פתח משם.
בתוך Safari רגיל זה לא יעבוד.

## בדיקות
```bash
node test-crypto.mjs     # הצפנת ההתראות + חתימת VAPID
node test-schedule.mjs   # לוגיקת התזמון של התזכורות
```

## איך זה עובד
- האפליקציה שולחת לשרת את לוח הזמנים שלך + תאריכי המשמרות הקרובות (90 יום)
- כל 15 דקות השרת בודק מה הגיע זמנו ושולח התראה
- כל תזכורת נשלחת פעם ביום לכל היותר
- לא נשמר בשרת שום מידע על שכר — רק תאריכים והעדפות התראה
