import asyncio
import sys


async def _main() -> None:
    # Import inside the coroutine so env vars are loaded before module init.
    from services.auto_upload_worker import auto_upload_daemon

    await auto_upload_daemon()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        sys.exit(0)

