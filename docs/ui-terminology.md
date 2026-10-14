# Kites app UI terminology

A plain-language guide to the names of common parts of the Kites app. These
terms are meant to make it easier to describe what you see and where you want
something to happen. You can always use your own words; this glossary gives us
shared shorthand.

## Navigation

| Term | What it means in Kites | Example wording |
| --- | --- | --- |
| **Screen** or **page** | One view in the app, such as Settings, About, a profile, or a market's details. “Screen” is the usual app term; “page” is equally clear in conversation. | “Open the About screen.” |
| **Navigation drawer** or **side drawer** | The panel that slides in from the side. It contains links such as Balances, Trading venues, Settings, and Sign out. It can be opened from the profile avatar or with a swipe. | “Put the Wallet link in the side drawer.” |
| **Bottom tab bar** | The row of five main buttons at the bottom on a phone: Feeds/Skyline, Search, Post, Notifications, and Profile. The Post button starts composing instead of switching to a feed. | “Make Wallet a bottom tab.” |
| **Tab bar** or **scrollable tabs** | A row of labels that switches sections within the current screen. A profile has tabs such as Posts, Replies, Media, Likes, and Markets; the row can scroll sideways to show more. | “Add a Positions tab to the profile tabs.” |
| **Navigation stack** | A history of screens. Opening a new screen can put it on top of the current one; Back returns to the previous screen. | “View All Markets opens a screen on top of the feed.” |
| **Route** | The app's internal destination for a screen. You usually don't need to know its name or path; saying the screen's visible title is enough. | “The About route is inside Settings.” |
| **Back button** | Returns to the screen underneath the current one, or closes a temporary panel. | “Back should return to the market list.” |
| **Header** or **navigation bar** | The strip at the top of a screen, often showing its title and Back or Close controls. | “Show the market name in the header.” |

## Panels that appear over a screen

| Term | What it means in Kites | Example wording |
| --- | --- | --- |
| **Sheet** or **bottom sheet** | A panel that comes up from the bottom and can often be dragged up or down. “Sheet” is a good general term for the panel you described as a “paper.” | “Open the trade sheet.” |
| **Form sheet** | A sheet-style screen used for a focused task. The market trade screen is presented this way on iOS, with a grab handle; on Android it appears as a modal that slides up from the bottom. | “Show the order form in a form sheet.” |
| **Modal** | A temporary view shown over the current screen. It may fill the screen or appear as a sheet. Close or dismiss it to return to what was underneath. | “Show a confirmation modal before sending.” |
| **Action sheet** | A short menu of choices that appears after tapping an action. For example, a trade button can show trade choices or venue setup choices. | “The action sheet should offer Buy and Sell.” |
| **Toast** | A brief status message that appears and disappears on its own, such as “Transfer confirmed.” | “Show a toast when the deposit address is copied.” |

## Content and controls

| Term | What it means in Kites | Example wording |
| --- | --- | --- |
| **Feed** | A scrolling list of posts. | “Show the market post in the feed.” |
| **Post** | A social message published by an account. | “The post contains a Polymarket link.” |
| **Embed** or **widget** | A rich card shown inside a post when Kites recognizes a supported link. A market embed can show market information and trading actions. | “The post’s market widget should show the current price.” |
| **Card** | A bounded block of related information, often with its own actions. A market card can appear inside an embed or in a market list. | “Keep the balance card separate from the positions card.” |
| **List row** | One horizontal item in a list, often with a title, icon, and a tap action. Settings uses grouped list rows. | “Add Wallet as a row in Settings.” |
| **Badge** | A small marker attached to an icon or label, often showing a count. Notifications may show an unread-count badge. | “Show a badge for pending actions.” |
| **Loading indicator** | A spinner or other sign that the app is waiting for data or an action to finish. | “Keep the loading indicator visible while balances load.” |
| **Empty state** | The message and actions shown when a section has no content yet. | “What should the empty state say when there are no positions?” |

## Your market example, in app terms

The flow you described can be called:

1. A **market embed** appears inside a social **post**.
2. Tapping **View all markets** opens a market **details screen** on the
   navigation **stack**, above the screen you came from.
3. Tapping a market action opens the **trade sheet** over the details screen.
4. Dismissing the sheet returns to market details; pressing Back returns to the
   earlier screen.

The exact animation can differ by device, but “market details screen” and
“trade sheet” should identify the parts clearly.

## A note on Settings and About

**Settings** opens over the main app. **About** is another screen inside
Settings, reached from the “About Kites” row. You can describe either one
simply as a screen or page; “nested screen” is optional terminology for
explaining that About is inside Settings.

## Quick reference

- Side panel with app links: **navigation drawer**
- Five main buttons along the bottom: **bottom tab bar**
- Profile sections that scroll sideways: **scrollable tabs**
- A new full view opened above the current one: **screen on the navigation
  stack**
- A draggable panel rising from the bottom: **sheet** or **bottom sheet**
- A temporary view on top of another view: **modal**
- Choices shown after tapping an action: **action sheet**
- Rich market card inside a post: **market embed** or **market widget**
