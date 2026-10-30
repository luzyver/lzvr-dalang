#!/usr/bin/env python3
"""
Start one or more servers, wait for them to be ready, run a command, then clean up.

Usage:
    # Single server
    python scripts/with_server.py --server "npm run dev" --port 5173 -- python automation.py
    python scripts/with_server.py --server "npm start" --port 3000 -- python test.py

    # Multiple servers
    python scripts/with_server.py \
      --server "cd backend && python server.py" --port 3000 \
      --server "cd frontend && npm run dev" --port 5173 \
      -- python test.py
"""

import subprocess
import socket
import time
import sys
import os
import signal
import argparse

def is_server_ready(port, timeout=30):
    """Wait for server to be ready by polling the port."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with socket.create_connection(('localhost', port), timeout=1):
                return True
        except (socket.error, ConnectionRefusedError):
            time.sleep(0.5)
    return False


def start_server(cmd):
    """Start a server in its own process group. Output is inherited, so a chatty server never blocks on a full pipe."""
    if os.name == 'nt':
        return subprocess.Popen(cmd, shell=True, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    return subprocess.Popen(cmd, shell=True, start_new_session=True)


def stop_server(process):
    """Stop the whole process tree started for a server, not only the shell that launched it."""
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(process.pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        process.wait(timeout=10)
        return
    # The shell may exit on SIGTERM while its children ignore it, so watch the whole group, not just the shell.
    pgid = process.pid

    def group_alive():
        process.poll()  # reap the shell so it does not keep the group alive as a zombie
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + 5
    while group_alive() and time.time() < deadline:
        time.sleep(0.1)
    if group_alive():
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait()


def port_in_use(port):
    try:
        with socket.create_connection(('localhost', port), timeout=1):
            return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description='Run command with one or more servers')
    parser.add_argument('--server', action='append', dest='servers', required=True, help='Server command (can be repeated)')
    parser.add_argument('--port', action='append', dest='ports', type=int, required=True, help='Port for each server (must match --server count)')
    parser.add_argument('--timeout', type=int, default=30, help='Timeout in seconds per server (default: 30)')
    parser.add_argument('command', nargs=argparse.REMAINDER, help='Command to run after server(s) ready')

    args = parser.parse_args()

    # Remove the '--' separator if present
    if args.command and args.command[0] == '--':
        args.command = args.command[1:]

    if not args.command:
        print("Error: No command specified to run")
        sys.exit(1)

    # Parse server configurations
    if len(args.servers) != len(args.ports):
        print("Error: Number of --server and --port arguments must match")
        sys.exit(1)

    servers = []
    for cmd, port in zip(args.servers, args.ports):
        servers.append({'cmd': cmd, 'port': port})

    server_processes = []

    try:
        # Start all servers
        for i, server in enumerate(servers):
            print(f"Starting server {i+1}/{len(servers)}: {server['cmd']}")

            # shell=True supports commands with cd and &&
            process = start_server(server['cmd'])
            server_processes.append((process, server['port']))

            # Wait for this server to be ready
            print(f"Waiting for server on port {server['port']}...")
            if not is_server_ready(server['port'], timeout=args.timeout):
                raise RuntimeError(f"Server failed to start on port {server['port']} within {args.timeout}s")

            print(f"Server ready on port {server['port']}")

        print(f"\nAll {len(servers)} server(s) ready")

        # Run the command
        print(f"Running: {' '.join(args.command)}\n")
        result = subprocess.run(args.command)
        sys.exit(result.returncode)

    finally:
        # Clean up all servers
        print(f"\nStopping {len(server_processes)} server(s)...")
        still_running = []
        for i, (process, port) in enumerate(server_processes):
            try:
                stop_server(process)
            except Exception as e:
                print(f"Server {i+1}: error while stopping: {e}")
            deadline = time.time() + 5
            while port_in_use(port) and time.time() < deadline:
                time.sleep(0.25)
            if port_in_use(port):
                still_running.append(port)
                print(f"Server {i+1} may still be running: port {port} is in use")
            else:
                print(f"Server {i+1} stopped")
        if still_running:
            print(f"Warning: ports still in use after cleanup: {still_running}")
        else:
            print("All servers stopped")


if __name__ == '__main__':
    main()