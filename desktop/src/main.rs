mod config;
mod console;
mod control;
mod http;
mod hub;
mod identity;
#[cfg(unix)]
mod ipc;
mod peer;
mod presence;
mod protocol;
mod rate;
mod server;
mod session;
#[cfg(target_os = "linux")]
mod tray;
mod ws;

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use config::{AppPaths, Settings};
use control::ControlRequest;
use hub::{Hub, Setting};
use server::Server;

const USAGE: &str = "\
Usage: Parousia-Desktop [command] [--json]

With no command, runs Parousia Desktop (or, if it's already running, shows
where it is). It logs nothing unless debug logging is turned on for the run.

Commands (talk to the running Desktop):
  status                        Connected browsers, settings, recent events
  debug on|off                  Debug logging and event history, for this run only
  set userscripts on|off        Allow userscripts (lets any web page connect; off by default)
  allow <origin>                Trust a Parousia extension build by its exact origin
  disallow <origin>             Stop trusting it

  --headless                    Run without a tray icon
  --debug                       Start with debug logging on
  --json                        Print command results as JSON";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let json = args.iter().any(|arg| arg == "--json");
    let debug = args.iter().any(|arg| arg == "--debug");
    let args: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--json" && *arg != "--debug")
        .collect();

    let set = |setting, value: &str| ControlRequest::Set {
        setting,
        value: value == "on",
    };
    match args.as_slice() {
        [] => run_desktop(true, debug),
        ["--headless"] => run_desktop(false, debug),
        ["status"] => send(ControlRequest::Status, json),
        ["debug", value @ ("on" | "off")] => {
            send(ControlRequest::Debug { on: *value == "on" }, json)
        }
        ["set", "userscripts", value @ ("on" | "off")] => {
            send(set(Setting::AllowUserscripts, value), json)
        }
        ["allow", origin] => send(
            ControlRequest::Allow {
                origin: (*origin).to_string(),
            },
            json,
        ),
        ["disallow", origin] => send(
            ControlRequest::Disallow {
                origin: (*origin).to_string(),
            },
            json,
        ),
        ["--version" | "-V"] => {
            println!("Parousia-Desktop {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["--help" | "-h" | "help"] => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("parousia-desktop: {message}");
    ExitCode::FAILURE
}

/// Silent unless `debug`: startup notes, connections, and refusals only
/// print (and are only kept for `status`) in debug mode.
fn run_desktop(with_tray: bool, debug: bool) -> ExitCode {
    let paths = match AppPaths::resolve() {
        Ok(paths) => paths,
        Err(err) => return fail(format!("failed to set up the app data directory: {err}")),
    };
    let config_path = paths.config_path();
    let settings = match Settings::load(&config_path) {
        Ok(settings) => settings,
        Err(err) => return fail(format!("invalid {}: {err}", config_path.display())),
    };

    // The IPC socket doubles as the single-instance check.
    #[cfg(unix)]
    let ipc_listener = match ipc::bind(&paths.socket_path()) {
        Ok(listener) => listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            println!("Parousia Desktop is already running.");
            return send(ControlRequest::Show, false);
        }
        Err(err) => return fail(err),
    };

    // Without the port no browser can reach Desktop, so there's nothing to
    // run. Where there's no IPC socket yet, this also stops a second Desktop.
    let listener = match Server::bind() {
        Ok(listener) => listener,
        Err(err) => {
            return fail(format!(
                "can't listen on {} ({err}); is something else using that port?",
                server::ADDRESS
            ));
        }
    };
    let hub = Arc::new(Hub::new(settings, config_path, server::ADDRESS.to_string()));
    hub.set_debug(debug);
    {
        let server = Server::new(Arc::clone(&hub));
        thread::spawn(move || server.serve(listener));
    }
    if debug {
        println!("Parousia Desktop listening on {}", server::ADDRESS);
    }
    #[cfg(unix)]
    {
        let hub = Arc::clone(&hub);
        thread::spawn(move || ipc::serve(ipc_listener, hub));
    }
    if debug {
        println!(
            "Parousia Desktop: settings in {}",
            paths.config_path().display()
        );
    }

    if std::io::stdin().is_terminal() {
        console::spawn(Arc::clone(&hub), quit);
    }
    #[cfg(target_os = "linux")]
    if with_tray {
        match tray::run(Arc::clone(&hub)) {
            tray::Exit::Quit => quit(),
            tray::Exit::Unavailable(reason) if hub.debug() => eprintln!(
                "parousia-desktop: no desktop session ({reason}); still running. Use `Parousia-Desktop status`."
            ),
            tray::Exit::Unavailable(_) => {}
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = with_tray;
    loop {
        thread::park();
    }
}

/// Removes the socket so the next start doesn't have to probe it.
fn quit() -> ! {
    #[cfg(unix)]
    if let Ok(paths) = AppPaths::locate() {
        let _ = std::fs::remove_file(paths.socket_path());
    }
    std::process::exit(0)
}

#[cfg(unix)]
fn send(request: ControlRequest, json: bool) -> ExitCode {
    let paths = match AppPaths::locate() {
        Ok(paths) => paths,
        Err(err) => return fail(err),
    };
    match ipc::request(&paths.socket_path(), &request) {
        Ok(response) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&response).expect("ControlResponse always serializes")
                );
            } else {
                println!("{}", control::describe(&response));
            }
            if matches!(response, control::ControlResponse::Error { .. }) {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(err) => fail(err),
    }
}

#[cfg(not(unix))]
fn send(_request: ControlRequest, _json: bool) -> ExitCode {
    fail(
        "controlling Desktop from another terminal isn't supported on this platform yet; type the command into Desktop's own window instead",
    )
}
