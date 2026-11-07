# LoraTagSmith

LoraTagSmith is a local-first LoRA dataset workspace for image captioning, prompt authoring, project settings, and batch workflows. It uses a React/Vite interface, a Node.js job server, and a Python/Pillow worker.

## Why LoraTagSmith Exists

LoraTagSmith was created to solve a recurring problem in character LoRA dataset preparation: a vision model may describe an image correctly, but still mix permanent character identity with temporary clothing, jewelry, pose, and environment. When those concepts are mixed together, captions become inconsistent across a dataset and the resulting LoRA can learn details that should have been removable.

The goal is not only to generate captions. The goal is to create a repeatable captioning workspace where:

- permanent character identity is described consistently;
- temporary clothing and accessories remain separate concepts;
- every caption follows the same structure and formatting rules;
- a character can be trained from many different outfits, poses, and environments;
- the user can review, edit, retry, and history-track captions before committing them to the dataset.

## The Core Idea: Layered Prompting

LoraTagSmith uses two prompt layers instead of one large, improvised instruction:

1. **Master Prompt**: the global captioning contract. It defines the output format, ordering, level of detail, framing, art style, environment description, and the difference between intrinsic and removable features.
2. **Character-Specific Rules**: the identity lock for one character. It defines the permanent traits that should remain stable across images, such as hair structure, eye color, horns, scars, tattoos, tails, wings, or other anatomy.

The **Trigger Word** is entered separately in the project UI. LoraTagSmith prepends it to the generated caption, so it does not need to be repeated inside either prompt layer.

The application combines these layers for every image. This means the master prompt can remain stable across a project while the character rules can change when training a different character. The model receives a clear distinction between what belongs to the character and what belongs only to the current image.

### Master Prompt Example

The master prompt is the reusable global instruction. A project can use a prompt like this:

```text
Analyze the provided image thoroughly and generate a comprehensive, highly detailed caption suitable for SDXL character LoRA training. Avoid preamble, start directly with the description.

CORE FRAMEWORK:
You must strictly separate the character's intrinsic genetic/body features from their temporary clothing and accessories.
- Intrinsic Character Features: Describe permanent body traits such as tattoos, scars, special skin markings, body lines, eye colors, specific multi-tone hair structures, and non-human body parts. Tie these traits consistently to the character being trained.
- Removable Attire & Accessories: Describe all clothing, jewelry, chokers, wrist or arm bands, and hip attachments as separate, temporary items with precise shapes, colors, and textures.

STRUCTURE TO FOLLOW:
1. Art Style & Framing: Identify the medium and shot type.
2. Intrinsic Character Breakdown: Focus on permanent genetic features.
3. Clothing & Fit: Detail the current outfit, fabric, and fit.
4. Removable Accessories: Detail independent jewelry and straps.
5. Environment: Detail background elements, lighting, and atmosphere.

Output the final response as a single, dense, descriptive paragraph that naturally blends all details together into a seamless caption. The application adds the configured trigger word at the beginning of the final caption.
```

### Character-Specific Rules Example

The character-specific prompt is supplied separately for the character being trained. For example:

```text
Intrinsic Features to lock for this character:
- Long dark blue hair with a vibrant purple/magenta under-dye layer.
- A bright red highlight streak on the center bangs.
- A pair of sharp dark red and black geometric horns on her head.
- A thin vertical red body-line marking extending from her neck down to her torso.
- A monstrous dark purple dragon hand and arm with sharp claws on her left side.
- A normal human right hand.

These are permanent identity features. Do not treat them as clothing, accessories, or temporary styling. Clothing, jewelry, pose, lighting, and environment remain removable image-level details.
```

For an image of this character, the application adds the configured trigger word and preserves the identity rules while still describing the image-specific outfit and setting. A simplified result might look like:

```text
shinku_nte, anime style, full body shot, long dark blue hair with vibrant purple magenta under-dye and a bright red center-bang streak, sharp dark red and black geometric horns, vertical red body-line marking, dark purple dragon left arm with sharp claws, normal human right hand, white blouse, black and red accessories, standing outdoors in a sunlit courtyard, detailed background, soft shadows
```

The exact output depends on the selected caption format and vision model. The important behavior is the separation: the character's locked anatomy stays attached to `shinku_nte`, while the outfit and environment can change from image to image.

## Development Philosophy

LoraTagSmith is intentionally local-first. Images and captions stay on the user's machine, local providers such as llama.cpp and Ollama work without a cloud account, and cloud providers are optional. The interface is designed around the real dataset workflow: select a project, choose a dataset, compose layered prompts, inspect images, queue a batch, edit captions, and retry only what needs attention.

The project also favors reversible operations. Existing captions are visible before replacement, caption history is kept at dataset level, individual images can be retried, and a user can choose whether to process only missing captions or intentionally retag existing ones.

## Requirements

- Node.js 20+ and npm
- Python 3.11+ (pyenv is supported)
- A supported vision provider: llama.cpp, Ollama, OpenAI, Google Gemini, Anthropic Claude, or DeepSeek

## Setup on CachyOS

```bash
git clone https://github.com/Cr-i/LoraTagSmith.git
cd LoraTagSmith
npm install
npm --prefix web install
pyenv install 3.11.9  # only if this version is not already installed
pyenv local 3.11.9
python -m venv .venv
source .venv/bin/activate
python -m pip install -r worker/requirements.txt
ollama pull qwen2.5-vl  # only required when using Ollama
```

For llama.cpp server, start the vision model server with its OpenAI-compatible API enabled, normally on `http://localhost:8080`. For Ollama, start another terminal with `ollama serve`. Then run development mode:

```bash
npm run dev
```

Open `http://localhost:5173`. The server binds to `0.0.0.0:3000`, so another trusted LAN device can use `http://YOUR-COMPUTER-IP:5173` during development. For a production-style run:

```bash
npm run build
NODE_ENV=production npm start
```

## Configuration

- `HOST`: server bind address, default `0.0.0.0`
- `PORT`: server port, default `3000`
- `PYTHON_BIN`: Python executable, default `python3`; set this to `.venv/bin/python` when using the project environment
- `PROJECTS_FILE`: optional path for the local project database; defaults to `server/data/projects.json` and is intentionally ignored by Git
- The UI defaults to `llama.cpp server`, `http://localhost:8080`, and the configured vision model. Select `Ollama` and use `http://localhost:11434` when using Ollama.
- Cloud providers use an API key field for model loading, connection testing, prompt generation, and captioning. The key is sent only with requests and is not stored in local browser settings or project JSON files.
- Use `Load models` to query the selected provider and `Test connection` to verify its model endpoint before starting a batch. You can still type a custom model name manually.

The UI stores form values in browser local storage. Captions overwrite existing sibling `.txt` files with the same stem. Supported source images are PNG, JPG, and JPEG.

Project settings, caption history, and API keys are local runtime data. API keys are held in memory and are not written to project JSON or browser local storage. Do not commit `server/data/projects.json`, `.caption-history.json`, dataset images, or generated caption files.

This application has no authentication by default. Use it only on a trusted LAN and do not forward the port to the public internet.

## GitHub safety checklist

Before pushing, run:

```bash
git status --short --ignored
git grep -n -I -E 'AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}' -- ':!package-lock.json' ':!web/package-lock.json'
```

The second command should return no API keys. If a key has ever been committed, revoke it at the provider before publishing; adding it to `.gitignore` does not remove it from Git history.

## License

MIT. See [LICENSE](LICENSE).
