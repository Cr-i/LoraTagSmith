# LoraTagSmith

LoraTagSmith is a local-first LoRA dataset workspace for image captioning, prompt authoring, project settings, and batch workflows. It uses a React/Vite interface, a Node.js job server, and a Python/Pillow worker.

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
