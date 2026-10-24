# Ping on Google Play — listing and Play Console forms

Everything here is ready to paste. The section names match Play Console's menus.

---

## Create app

| Field | Value |
|---|---|
| App name | Ping - Event Planner |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free |
| Declarations | Check both (Developer Program Policies, US export laws) |

---

## Grow → Store presence → Main store listing

**App name** (max 30)
```
Ping - Event Planner
```

**Short description** (max 80)
```
Plan get-togethers with family and friends. Invite, RSVP, and see who's coming.
```

**Full description** (max 4000)
```
Ping makes it easy to plan events with the people who matter: family dinners, birthdays, game nights, trips, practices, and everything in between.

PLAN IN A FEW TAPS
• Tap New Event, add what, when, and where, and you're done.
• Invite people from your contacts or a saved group. Friends on Ping get a notification; anyone else gets a text with a link they can answer without an account.
• Keep it just for you: an event with no guests stays private, and you can invite people any time later.

SEE WHO'S COMING
• Going, Maybe, and Can't go at a glance.
• Reminders before the event, and a chat for each event and group.

SORT OUT WHO'S BRINGING WHAT
• Add a "What to bring" list and let guests claim items, so you don't end up with five bags of chips.
• Add stops for trips and multi-stop days.

A CALENDAR THAT WORKS LIKE ONE
• Month, Week, 2 Days, and Day views, with your phone's calendar alongside if you want it.
• Hold an event to drag it to a new time or day.
• Mark Important dates like birthdays and anniversaries to repeat every year with a reminder.
• Events keep the right time when you travel across time zones.

DISCOVER THINGS TO DO
• Find local events, concerts, games, and family activities near you (now in Utah and Boise, Idaho, with more areas coming).

Ping is free, has no ads, and never sells your information.

Made by Hivebuilt LLC in Alpine, Utah. Questions or ideas? hello@hivebuilt.dev
```

**Graphics**
- App icon: `google-play/icon-512.png` (512×512)
- Feature graphic: `google-play/feature-graphic.png` (1024×500)
- Phone screenshots: `google-play/phone/` (1080×2160, upload in order)

**Store settings**
| Field | Value |
|---|---|
| App category | Lifestyle (matches the App Store) |
| Tags | Event planning, Calendar, Family |
| Email | hello@hivebuilt.dev |
| Website | https://hivebuilt.dev |
| Phone | optional, leave blank |

---

## Policy → App content

### Privacy policy
```
https://pingmobileapp.github.io/Ping/privacy.html
```

### App access
Choose **All or some functionality is restricted**, then add instructions:
- Name: `Demo account`
- Username: `pierson.willhite+applereview3@gmail.com`
- Password: *(same as the Apple review account)*
- Any other information:
```
Sign in with the email and password on the first screen. The account is pre-loaded with sample events, guests, and a "What to bring" list. Discover shows Utah and Boise, Idaho events; elsewhere it shows a "not in your area yet" card, which is expected.
```

### Ads
**No, my app does not contain ads.**

### Content rating (IARC questionnaire)
- Email: hello@hivebuilt.dev
- Category: **All other app types** (not a game, not social networking-first, not a reference/news app)
- Violence, sexuality, language, controlled substances, gambling, crude humor: **No** to each
- **Does the app allow users to interact or exchange content?** **Yes.** Users share events and messages with people they invite.
- **Does the app share the user's current location with other users?** **No.**
- **Does the app allow users to purchase digital goods?** **No.** Discover ticket sales are for real-world events.
- **Is the app a web browser or search engine?** No

Expected result: Everyone / PEGI 3, with an "Users Interact" notice.

### Target audience and content
- Target age groups: **18 and over** (also safe to add 13–17; don't select anything under 13, since that brings Families policy requirements)
- Appeals to children? **No**

### News app
**No**

### Government app
**No**

### Financial features
**My app doesn't provide any financial features.** Discover ticket checkout goes to Stripe for in-person event tickets, which Play treats as physical/real-world goods, not a financial service.

### Health
**My app does not have any health features.**

### Account deletion (required)
- Can users create an account? **Yes**
- Delete account URL:
```
https://pingmobileapp.github.io/Ping/support.html
```
(The "How do I delete my account?" section explains Settings → Delete Account in the app, and email for anyone who can't sign in.)
- Users can also delete specific data without deleting the account? **Yes** (phone number, profile photo, their own events and messages)

---

## Data safety

**Overview answers**
| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (HTTPS to Supabase and every service) |
| Do you provide a way for users to request that their data is deleted? | **Yes** |

Under Play's definitions, sending data to service providers that process it for you (Supabase, Anthropic, Stripe, Expo push, OpenStreetMap/Open-Meteo, Google and Apple sign-in) counts as **collected**, not **shared**. So everything below is **Collected: yes, Shared: no**.

For each data type, Play asks: collected or shared, ephemeral?, required or optional, and purposes.

| Data type (Play's name) | Required? | Purposes | Notes |
|---|---|---|---|
| **Personal info → Name** | Optional | App functionality, Account management | Display name on profile and guest lists |
| **Personal info → Email address** | Required | App functionality, Account management | Sign-in |
| **Personal info → Phone number** | Optional | App functionality | Matching invites to accounts |
| **Personal info → User IDs** | Required | App functionality, Account management | Account ID |
| **Location → Approximate location** | Optional | App functionality | Only when the user taps "Let me know" in Discover (rounded ~7 mi). Location for nearby events stays on the device |
| **Photos and videos → Photos** | Optional | App functionality | Event and profile photos the user picks, and Scan a Schedule |
| **Messages → Other in-app messages** | Optional | App functionality | Event and group chats |
| **Contacts → Contacts** | Optional | App functionality | Only the contacts the user chooses to import |
| **Calendar → Calendar events** | Optional | App functionality | Mark **Ephemeral: yes**. Read on the device to show alongside Ping, not uploaded. Some people answer "not collected" for on-device-only data; "collected, ephemeral" is the safer answer |
| **Other user-generated content** | Optional | App functionality | Events, RSVPs, What to bring items, day notes |
| **Financial info → Purchase history** | Optional | App functionality | Record of a Discover ticket purchase. Card numbers go to Stripe, never to Ping |
| **App activity → App interactions** | Optional | App functionality | RSVPs, claims, Discover "interested" marks |
| **Device or other IDs** | Required for push | App functionality | Push notification token |

**Not collected** (answer No):
Precise location, health and fitness, files and docs, audio, web browsing, app info and performance (crash logs, diagnostics), race/ethnicity, political or religious beliefs, sexual orientation, other personal info, credit score, other financial info, emails, SMS.

**Purposes never used:** Advertising or marketing, Personalization (beyond the app's own features), Analytics, Fraud prevention, Developer communications.

**Security practices to declare:**
- Data is encrypted in transit: **Yes**
- Users can request data deletion: **Yes**
- Committed to Play Families Policy: **No** (not a children's app)
- Independent security review: **No**

---

## Release → Testing / Production (first upload)

- Upload `.aab` from the EAS build (Expo dashboard → Ping → Builds → Android, version code 2, Download).
- Release name: `1.1.15 (2)`
- Release notes:
```
<en-US>
Welcome to Ping on Android! Plan get-togethers with family and friends: invite people, see who's coming, sort out who's bringing what, and keep your calendar in one place.
</en-US>
```
- Play App Signing: accept Google's default ("Let Google manage and protect your app signing key"). The key EAS uses becomes the upload key.

Recommendation: send the first release to **Internal testing** (just you and family) for a day, then promote it to Production. As an organization account, there is no 12-tester / 14-day closed-testing requirement.
