from __future__ import annotations

import argparse

def main() -> int:
    parser = argparse.ArgumentParser(description="Flowave local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=29613)
    parser.add_argument("--sound-map-worker", default="")
    args = parser.parse_args()
    if args.sound_map_worker:
        from sound_map import worker_main
        return worker_main(args.sound_map_worker)
    import uvicorn
    from api import app
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("公开版后端只允许监听本机 loopback")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        access_log=False,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
