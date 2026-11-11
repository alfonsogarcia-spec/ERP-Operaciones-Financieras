#!/usr/bin/env python3
"""Hook de Claude Code para la Oficina Polipay.

Registra qué agente está trabajando:
  - en local: <proyecto>/10_oficina/estado/actividad.json (si el proyecto tiene 10_oficina/)
  - en línea: POST a la API de la oficina, si existe ~/.config/oficina-polipay/config.json
    ({"url": "https://...", "token": "ofp_...", "enviar_prompt": false}) o las variables OFICINA_URL / OFICINA_TOKEN.

Eventos (argumento 1):
  inicio   PreToolUse del tool Agent/Task
  fin      PostToolUse del tool Agent/Task
  error    PostToolUseFailure del tool Agent/Task (agente inexistente u otro fallo)
  sub-fin  SubagentStop
  prompt   UserPromptSubmit (Recepción atiende)
  stop     Stop (Recepción queda libre)
Argumento opcional --global: instalado en ~/.claude/settings.json; se omite si el proyecto ya trae su propio hook.

Nunca bloquea a Claude: ante cualquier error sale con código 0 sin imprimir nada.
"""
import datetime, json, os, socket, sys, time, urllib.request

MAX_RECIENTES = 60
LANZAMIENTO_RAPIDO_S = 5
CONFIG = os.path.expanduser("~/.config/oficina-polipay/config.json")


def ahora():
    return time.time()


def iso(ts):
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def config_remota():
    cfg = {}
    try:
        with open(CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        pass
    url = os.environ.get("OFICINA_URL") or cfg.get("url")
    token = os.environ.get("OFICINA_TOKEN") or cfg.get("token")
    return (url.rstrip("/"), token, bool(cfg.get("enviar_prompt"))) if url and token else (None, None, False)


def contexto_ssl():
    # El Python de python.org en macOS no trae certificados: usa certifi o los del sistema.
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


def enviar(url, token, ruta, datos):
    req = urllib.request.Request(url + ruta, data=json.dumps(datos).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token,
                                          "User-Agent": "oficina-polipay-hook/1.0"})
    urllib.request.urlopen(req, timeout=2.5, context=contexto_ssl()).read()


def agente_existe(tipo, proyecto_dir):
    # Solo se registra un agente que realmente existe en el proyecto o en ~/.claude/agents; si no existe,
    # el tool Agent falla de inmediato y nunca llegaría el aviso de fin (quedaría "Trabajando" para siempre).
    if not tipo or "/" in tipo or "\\" in tipo:
        return False
    return any(os.path.exists(os.path.join(d, tipo + ".md")) for d in
               (os.path.join(proyecto_dir, ".claude", "agents"), os.path.expanduser("~/.claude/agents")))


def escribir_local(base, evento, entrada, ti):
    import fcntl
    archivo = os.path.join(base, "estado", "actividad.json")
    os.makedirs(os.path.dirname(archivo), exist_ok=True)
    with open(archivo + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        d = {"activos": {}, "recientes": []}
        try:
            with open(archivo, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            pass

        def terminar(clave):
            act = d["activos"].pop(clave, None)
            if act:
                fin = ahora()
                d["recientes"].insert(0, {"agente": act["agente"], "descripcion": act["descripcion"], "inicio": act["inicio"],
                                          "fin": iso(fin), "duracion_s": round(fin - act["inicio_ts"])})
                del d["recientes"][MAX_RECIENTES:]

        clave = entrada.get("tool_use_id") or f"{ti.get('subagent_type')}:{ti.get('description', '')}"
        if evento == "inicio" and ti.get("subagent_type"):
            d["activos"][clave] = {"agente": ti["subagent_type"], "descripcion": ti.get("description") or "Trabajando",
                                   "inicio": iso(ahora()), "inicio_ts": ahora()}
        elif evento == "fin" and ti.get("subagent_type"):
            act = d["activos"].get(clave)
            if act and ahora() - act["inicio_ts"] >= LANZAMIENTO_RAPIDO_S:
                terminar(clave)
        elif evento == "error":
            d["activos"].pop(clave, None)
        elif evento == "sub-fin":
            tipo = entrada.get("agent_type") or entrada.get("subagent_type")
            cands = sorted(((k, v) for k, v in d["activos"].items() if v["agente"] != "recepcion" and v["agente"] == tipo),
                           key=lambda kv: kv[1]["inicio_ts"])
            if cands:
                terminar(cands[0][0])
        elif evento == "prompt":
            texto = (entrada.get("prompt") or "Atendiendo petición").strip().replace("\n", " ")
            d["activos"]["recepcion"] = {"agente": "recepcion", "descripcion": texto[:90], "inicio": iso(ahora()), "inicio_ts": ahora()}
        elif evento == "stop":
            terminar("recepcion")

        tmp = archivo + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, archivo)


def main():
    args = sys.argv[1:]
    evento = args[0] if args else ""
    global_ = "--global" in args
    try:
        entrada = json.load(sys.stdin)
    except Exception:
        entrada = {}
    ti = entrada.get("tool_input") or {}
    proyecto_dir = os.environ.get("CLAUDE_PROJECT_DIR") or entrada.get("cwd") or os.getcwd()
    base_local = os.path.join(proyecto_dir, "10_oficina")

    # Instalación global: si el proyecto ya trae su hook de proyecto, no duplicar.
    if global_ and os.path.exists(os.path.join(base_local, "hooks", "actividad.py")):
        return

    if evento == "inicio" and not agente_existe(ti.get("subagent_type"), proyecto_dir):
        return

    if os.path.exists(os.path.join(base_local, "agentes.json")):
        try:
            escribir_local(base_local, evento, entrada, ti)
        except Exception:
            pass

    url, token, enviar_prompt = config_remota()
    if not url:
        return
    datos = {"evento": evento, "sesion": entrada.get("session_id") or "sin-sesion",
             "proyecto": os.path.basename(os.path.normpath(proyecto_dir)), "maquina": socket.gethostname().split(".")[0]}
    if evento in ("inicio", "fin", "error"):
        if not ti.get("subagent_type"):
            return
        datos.update(agente=ti["subagent_type"], descripcion=ti.get("description"),
                     clave=entrada.get("tool_use_id") or f"{ti['subagent_type']}:{ti.get('description', '')}")
    elif evento == "sub-fin":
        tipo = entrada.get("agent_type") or entrada.get("subagent_type")
        if not tipo:
            return
        datos["agente"] = tipo
    elif evento == "prompt":
        # Por privacidad, el texto de la petición solo se envía si enviar_prompt = true.
        if enviar_prompt:
            datos["descripcion"] = (entrada.get("prompt") or "").strip().replace("\n", " ")[:120]
    elif evento != "stop":
        return
    try:
        enviar(url, token, "/api/ingesta/evento", datos)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
