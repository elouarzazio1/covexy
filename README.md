# Covexy

**The AI that acts before you ask.**

Covexy is a proactive AI desktop app for macOS. It runs silently in the background, watches your screen, understands your context, and tells you what matters before you think to ask.

Most AI tools wait for you. You open them, you type, they respond. Covexy does the opposite. It observes, thinks, and speaks up only when it has something that genuinely changes what you do next.

---

## Why it exists

Every AI tool available today is reactive. You have to know what to ask before you can get help. But the most valuable information is often the thing you did not think to look for. The opportunity you almost missed. The risk that was obvious in hindsight. The pattern in your own work you were too busy to notice.

Covexy is built around one idea: proactive AI should act before you ask, not after.

---

## Use cases

**For founders and solo builders**
Covexy tracks your projects, monitors industry signals, and surfaces funding opportunities, competitor moves, or market shifts while you are heads down building.

**For researchers**
It notices when you keep returning to the same topic and surfaces what you missed, compiles a briefing, or flags a relevant new publication.

**For sales professionals**
It detects when a deal needs attention, surfaces a news signal about a prospect, or flags a risk in your pipeline before it becomes obvious.

**For content creators**
It notices when a topic you have been researching is trending and tells you this is the moment to publish.

**For anyone who works with information**
If you spend your day switching between tabs, documents, and tools, Covexy connects the dots across everything you are doing and tells you what matters.

---

## How it works

**Observer** captures your screen every 3 minutes, describes what you are working on in one sentence, and logs it locally on your device.

**Analyst** powered by DeepSeek R1 reads your full week of activity, pulls fresh signals from the web about your specific projects, and asks one question: is there something this person genuinely needs to know right now?

**Relevance filter** scores every insight from 1 to 10. Only insights scoring 9 or above reach you. Silence is the default, not the exception.

**Verification** runs a second web search to confirm any claim before surfacing it to you.

---

## Install

Download the latest DMG from the [Releases](https://github.com/elouarzazio1/covexy/releases) page.

Open it, drag Covexy to your Applications folder, and launch it. No terminal required.

You will need a free [OpenRouter](https://openrouter.ai) API key to power the intelligence. Optionally add a [Tavily](https://tavily.com) key for web search. Both have free tiers.

Personal use costs roughly 2 to 5 dollars per month in API costs.

---

## Tech stack

- Electron — macOS desktop app
- Gemini 2.0 Flash via OpenRouter — screen observation
- DeepSeek R1 via OpenRouter — analyst reasoning
- Tavily — web search and verification
- Local JSON — all memory stays on your device

---

## Roadmap

- ✓ v1.0 Core ambient intelligence
- ✓ v1.1 Cross-day pattern memory
- ○ v1.2 Model selector — choose your AI engine
- ○ v1.3 Local processing — full privacy mode
- ○ v2.0 Team intelligence

---

## Privacy

Screen observations are processed via OpenRouter to generate text descriptions. No raw screen content is stored on external servers. No data is sold. No account required. Everything else stays on your device.

---

## License

Apache 2.0 — free to use, modify, and distribute with attribution.

---

## Built by

Othmane El Ouarzazi

[covexy.com](https://covexy.com) · [LinkedIn](https://www.linkedin.com/company/covexylabs/)
