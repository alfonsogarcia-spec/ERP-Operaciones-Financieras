#!/usr/bin/env bash
# Conecta esta Mac a la Oficina Polipay en línea.
# Uso:  bash oficina/cliente/instalar.sh https://oficina-polipay.onrender.com ofp_TU_TOKEN
# - Copia el hook a ~/.config/oficina-polipay/
# - Guarda url + token en ~/.config/oficina-polipay/config.json (permisos 600)
# - Agrega los hooks a ~/.claude/settings.json (respaldo previo en settings.json.bak-oficina)
#   para que TODAS tus sesiones de Claude Code reporten a la oficina.
set -euo pipefail
URL="${1:-}"; TOKEN="${2:-}"
if [[ -z "$URL" || -z "$TOKEN" ]]; then echo "Uso: bash oficina/cliente/instalar.sh <url> <token>"; exit 1; fi
DIR="$HOME/.config/oficina-polipay"
mkdir -p "$DIR"
cp "$(dirname "$0")/actividad.py" "$DIR/actividad.py"
umask 077
python3 - "$URL" "$TOKEN" "$DIR/config.json" <<'PY'
import json, sys
url, token, ruta = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
json.dump({"url": url, "token": token, "enviar_prompt": False}, open(ruta, "w"), indent=2)
PY
chmod 600 "$DIR/config.json"
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[[ -f "$SETTINGS" ]] && cp "$SETTINGS" "$SETTINGS.bak-oficina"
python3 - "$SETTINGS" "$DIR/actividad.py" <<'PY'
import json, os, sys
ruta, script = sys.argv[1], sys.argv[2]
s = json.load(open(ruta)) if os.path.exists(ruta) else {}
hooks = s.setdefault("hooks", {})
def poner(evento, arg, matcher=None):
    cmd = f'python3 "{script}" {arg} --global'
    lista = hooks.setdefault(evento, [])
    for grupo in lista:
        for h in grupo.get("hooks", []):
            if "oficina-polipay/actividad.py" in h.get("command", "") and f" {arg} " in h["command"] + " ":
                h["command"] = cmd
                return
    g = {"hooks": [{"type": "command", "command": cmd}]}
    if matcher: g["matcher"] = matcher
    lista.append(g)
poner("UserPromptSubmit", "prompt"); poner("Stop", "stop"); poner("SubagentStop", "sub-fin")
poner("PreToolUse", "inicio", "Agent|Task"); poner("PostToolUse", "fin", "Agent|Task")
json.dump(s, open(ruta, "w"), indent=2, ensure_ascii=False)
PY
echo "Listo. Esta Mac reporta a $URL. Abre una sesión nueva de Claude Code para que cargue los hooks."
echo "Para desconectar: borra $DIR/config.json (los hooks quedan inactivos sin config)."
