#!/usr/bin/env bash

# Stop the script if a command fails, an unset variable is used, or a pipeline fails.
set -Eeuo pipefail

# Find the project root based on this script's location.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Move into the project root so Python can resolve the backend package.
cd "$ROOT_DIR"

# Use the project's virtual environment for all Python commands.
VENV_DIR="$ROOT_DIR/.venv"

# Create the virtual environment and install the backend dependencies.
setup() {
    # Create an isolated Python environment if it does not already exist.
    python3 -m venv "$VENV_DIR"

    # Activate the project's isolated Python environment.
    source "$VENV_DIR/bin/activate"

    # Upgrade pip inside the virtual environment.
    python -m pip install --upgrade pip

    # Install the dependencies declared by the backend.
    python -m pip install -r backend/requirements.txt

    # Install pytest for running the project's automated tests.
    python -m pip install pytest

    # Tell the user setup has completed.
    echo "Setup complete. Use ./dev.sh check or ./dev.sh demo."
}

# Activate the virtual environment before running project commands.
activate_environment() {
    # Stop with a helpful message if setup has not been run yet.
    if [[ ! -d "$VENV_DIR" ]]; then
        echo "Virtual environment not found. Run: ./dev.sh setup"
        exit 1
    fi

    # Activate the project's Python environment.
    source "$VENV_DIR/bin/activate"
}

# Compile the backend and execute the automated tests.
run_checks() {
    # Check every backend Python file for syntax and compilation errors.
    python -m compileall -q backend

    # Run the project's pytest suite with concise output.
    python -m pytest -q
}

# Read the requested command, defaulting to help.
COMMAND="${1:-help}"

# Select the requested development workflow.
case "$COMMAND" in
    # Install the virtual environment and project dependencies.
    setup)
        setup
        ;;

    # Run syntax checks and the automated test suite.
    check)
        activate_environment
        run_checks
        ;;

    # Run the backend checks and then start the HQ coordinator.
    demo)
        activate_environment
        run_checks
        python -m backend.coordinator.main
        ;;

    # Start a worker and pass any additional arguments to its command.
    worker)
        activate_environment
        shift
        python -m backend.worker.main "$@"
        ;;

    # Start HQ without running tests first.
    backend)
        activate_environment
        python -m backend.coordinator.main
        ;;

    # Display the available commands.
    help)
        echo "Borrowed Sky development commands:"
        echo "  ./dev.sh setup                  Create environment and install dependencies"
        echo "  ./dev.sh check                  Compile backend and run tests"
        echo "  ./dev.sh demo                   Run tests, then start HQ"
        echo "  ./dev.sh backend                Start HQ without running tests"
        echo "  ./dev.sh worker --host HOST     Start a worker"
        ;;

    # Reject commands that are not supported.
    *)
        echo "Unknown command: $COMMAND"
        echo "Run ./dev.sh help to see available commands."
        exit 1
        ;;
esac
