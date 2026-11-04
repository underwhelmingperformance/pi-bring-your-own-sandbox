import ctypes
import json
import sys
import uuid


class ErrorDetail(ctypes.Structure):
    _fields_ = [
        (key, ctypes.c_void_p)
        for key in ["message", "operation", "nativeCode", "remediation"]
    ]


class RunResult(ctypes.Structure):
    _fields_ = [
        ("status", ctypes.c_int32),
        ("exitCode", ctypes.c_int32),
        ("timedOut", ctypes.c_int32),
        ("stdout", ctypes.c_void_p),
        ("stderr", ctypes.c_void_p),
        ("error", ErrorDetail),
        ("outputMetadata", ctypes.c_void_p),
        ("warnings", ctypes.c_void_p),
    ]


def run_mxc(command, workspace, readonly, writable):
    lib = ctypes.CDLL(sys.argv[1])
    run = lib.mxc_run_json
    run.argtypes = [ctypes.c_char_p, ctypes.c_int32, ctypes.POINTER(RunResult)]
    run.restype = ctypes.c_int32
    free = lib.mxc_run_result_free
    free.argtypes = [ctypes.POINTER(RunResult)]
    request = {
        "version": "1.0.0",
        "containerId": uuid.uuid4().hex,
        "containment": "bubblewrap",
        "lifecycle": {"destroyOnExit": True, "preservePolicy": False},
        "process": {
            "commandLine": command,
            "timeout": 5000,
            "cwd": str(workspace),
            "env": ["PATH=/usr/bin:/bin"],
        },
        "filesystem": {
            "readonlyPaths": readonly,
            "readwritePaths": writable,
            "deniedPaths": [],
        },
        "network": {"egress": {"default": "deny"}, "ingress": {"default": "deny"}},
        "telemetry": {"enabled": False},
        "ui": {"disable": True},
    }
    result = RunResult()

    def decode(pointer):
        return ctypes.string_at(pointer).decode() if pointer else ""

    try:
        status = run(json.dumps(request).encode(), 0, ctypes.byref(result))
        return {
            "status": status,
            "nativeStatus": result.status,
            "exitCode": result.exitCode,
            "stdout": decode(result.stdout),
            "stderr": decode(result.stderr),
            "error": decode(result.error.message),
            "warnings": decode(result.warnings),
        }
    finally:
        free(ctypes.byref(result))


print(json.dumps(run_mxc(*json.loads(sys.argv[2]))))
