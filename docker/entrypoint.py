"""Supervise the private Python scorer and public Node API in one small container."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

STOPPING = False


def stop_requested(_signum, _frame):
    global STOPPING
    STOPPING = True


def stop_process(process):
    if process is None:
        return
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGTERM)
        elif process.poll() is None:
            process.terminate()
        process.wait(timeout=20)
    except ProcessLookupError:
        pass
    except subprocess.TimeoutExpired:
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait()


def main():
    global STOPPING
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    model = api = None
    try:
        # Fail before starting either child if deployment access control is missing.
        if not os.getenv('API_ACCESS_TOKEN'):
            raise RuntimeError('Set API_ACCESS_TOKEN in Render Environment before deploying')
        python = os.getenv('PYTHON_EXECUTABLE', sys.executable)
        node = os.getenv('NODE_EXECUTABLE', 'node')
        model = subprocess.Popen([python, 'model/server.py'], start_new_session=os.name == 'posix')
        address = f"http://127.0.0.1:{os.getenv('MODEL_PORT', '8001')}/health"
        deadline = time.monotonic() + 30
        while not STOPPING:
            if model.poll() is not None:
                raise RuntimeError('Python scoring service exited during startup')
            try:
                with urllib.request.urlopen(address, timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Python scoring service did not become ready')
                time.sleep(.1)
        if STOPPING:
            return 0
        api = subprocess.Popen([node, 'dist/main.js'], start_new_session=os.name == 'posix')
        while not STOPPING:
            if model.poll() is not None or api.poll() is not None:
                raise RuntimeError('A required application process exited; stopping the container')
            time.sleep(.2)
        return 0
    finally:
        stop_process(api)
        stop_process(model)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Futuro startup failed: {error}', file=sys.stderr)
        sys.exit(1)
