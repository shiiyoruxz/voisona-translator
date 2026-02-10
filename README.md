# 🌸 Leur-Translator (Live2D Edition)

> **Vibe:** Multimodal Virtual Assistant • Local-First • Windows-Native

`Leur-Translator` is an R&D project creating a localized, voice-enabled Virtual Persona. It bridges **Gemma 3** and **VoiSona Talk** with a **Live2D Cubism** interface for real-time interaction, orchestrated via a local **LiveKit** pipeline.

---

## 📽️ Project Demo

<p align="center">
  [Video Placeholder: Real-time Live2D Lipsync & Multilingual Translation]
</p>

---

## 🌟 Visual & Linguistic Features

### 🎙️ Voice & Display Logic
* **Multilingual UI:** Real-time simultaneous display of **Japanese, English, and Chinese** text for full accessibility.
* **Monolingual Voice:** Vocal synthesis is strictly **Japanese-only** via LeuR (VoiSona Talk) to preserve character identity.
* **Audio-Sync:** High-fidelity lipsync mapping; analyzing VoiSona audio output to drive Live2D mouth parameters (`ParamMouthOpenY`) in real-time.

### 🎭 Live2D Avatar
* **Core:** Powered by `live2dcubismcore.min` for lightweight, high-performance rendering.
* **Natural Motion:** Integrated auto-breathing, eye-blinking, and physics-based hair/clothing movement.
* **Trial Model:** Utilizing official Live2D SDK sample models (Hiyori/Haru) to achieve natural movement for R&D.

---

## 🧠 System Architecture

The project utilizes a low-latency media pipeline to sync the AI's "thought" process with visual and vocal output.



* **Brain:** [Ollama](https://ollama.com) running **Gemma 3: 1B** — Optimized for high-speed local CPU inference.
* **Orchestration:** [LiveKit](https://livekit.io) (Local Docker) — Acts as the real-time media backbone, handling audio streams between the LLM and the frontend.
* **Logic:** Custom Python-based LiveKit Agent managing the translation and parameter synchronization.

---

## 🛠️ Tech Stack

| Component | Technology | Status |
| :--- | :--- | :--- |
| **LLM Brain** | Ollama (`gemma3:1b`) | ✅ Active |
| **Media Server** | LiveKit (Docker Local) | ⚡ Running |
| **TTS Engine** | VoiSona Talk (Artist: LeuR) | 🎙️ Active |
| **Avatar Engine**| Live2D Cubism SDK for Web | 🎭 Integrated |
| **Backend** | Python (Logic & API Hook) | ⚙️ Native |

---

## 🚀 Future Roadmap
* 🎭 **Emotive Synthesis:** Auto-adjusting VoiSona parameters (Tone/Speed) based on LLM sentiment analysis.

---

## 📄 License
Personal R&D Project. Please respect the **VoiSona** and **Live2D SDK** Terms of Service regarding the use of LeuR's voice data and the Cubism core.

---
<p align="right">
  <i>Developed with 🌸 by <a href="https://github.com/shiiyoruxz">shiiyoruxz</a></i>
</p>
