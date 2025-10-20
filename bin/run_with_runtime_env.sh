#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/run/tricorder/runtime.env"
PYTHON_BIN="/apps/tricorder/venv/bin/python"
ENSURE_DIRS=0
DROPBOX_LINK=""

print_usage() {
    cat <<'USAGE' >&2
Usage: run_with_runtime_env.sh [--env-file PATH] [--python PATH] [--ensure-dirs] [--dropbox-link PATH] -- COMMAND [ARGS...]

Generate the runtime environment file using lib.unit_runtime, source it, and
then exec the provided command.
USAGE
}

ARGS=()
while (($#)); do
    case "$1" in
        --env-file)
            if (($# < 2)); then
                echo "Missing value for --env-file" >&2
                print_usage
                exit 64
            fi
            ENV_FILE="$2"
            shift 2
            ;;
        --python)
            if (($# < 2)); then
                echo "Missing value for --python" >&2
                print_usage
                exit 64
            fi
            PYTHON_BIN="$2"
            shift 2
            ;;
        --ensure-dirs)
            ENSURE_DIRS=1
            shift
            ;;
        --dropbox-link)
            if (($# < 2)); then
                echo "Missing value for --dropbox-link" >&2
                print_usage
                exit 64
            fi
            DROPBOX_LINK="$2"
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            break
            ;;
    esac
done

if (($# == 0)); then
    echo "COMMAND is required" >&2
    print_usage
    exit 64
fi

CMD=("$@")

UNIT_ARGS=("--env-file" "$ENV_FILE")
if ((ENSURE_DIRS)); then
    UNIT_ARGS+=("--ensure-dirs")
fi
if [[ -n "$DROPBOX_LINK" ]]; then
    UNIT_ARGS+=("--dropbox-link" "$DROPBOX_LINK")
fi

"$PYTHON_BIN" -m lib.unit_runtime "${UNIT_ARGS[@]}"

if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
else
    echo "Runtime environment file $ENV_FILE was not created" >&2
    exit 1
fi

exec "${CMD[@]}"
