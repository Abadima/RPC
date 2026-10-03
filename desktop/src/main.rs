// Release builds on Windows are GUI-subsystem: no console window behind the
// tray icon. Debug and test builds keep theirs.
#![cfg_attr(
    all(windows, not(debug_assertions), not(test)),
    windows_subsystem = "windows"
)]

mod adapters;
mod app;
mod link;
mod platform;

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use adapters::discord::{self, DiscordAdapter};
use app::config::{AppPaths, Settings};
use app::console;
use app::control::{self, ControlRequest};
use app::hub::{Hub, Setting};
use link::server::{self, Server};
use platform::TrayExit;

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
    // Commands typed into a terminal print there; a plain launch stays windowless.
    if std::env::args_os().len() > 1 {
        platform::attach_parent_console();
    }
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
    platform::alert(&message.to_string());
    ExitCode::FAILURE
}

/// What to tell someone whose Desktop can't take its port. The port is fixed
/// (the extensions connect to exactly this address), so the fix is theirs.
/// `holder` is who has it, where that can be told.
fn bind_failure(err: &std::io::Error, holder: platform::Owner) -> String {
    let address = server::ADDRESS;
    if err.kind() == std::io::ErrorKind::AddrInUse && holder == platform::Owner::OtherUser {
        format!(
            "port {} is held by a program another user on this computer runs, so Parousia Desktop can't start, and Parousia in your browsers may be sending it what you're doing instead. Find out what's using {address}, or ask an administrator, before using Parousia here.",
            server::DEFAULT_PORT
        )
    } else if err.kind() == std::io::ErrorKind::AddrInUse {
        format!(
            "port {} is already in use, so Parousia Desktop can't start. Close whatever is using {address} (often another copy of Parousia Desktop that a previous run left behind), then start it again.",
            server::DEFAULT_PORT
        )
    } else {
        format!("can't listen on {address}: {err}. Browsers can only reach Parousia Desktop there.")
    }
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

    // The control socket doubles as the single-instance check.
    let control_server = match platform::control::claim(&paths) {
        Ok(server) => server,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            println!("Parousia Desktop is already running.");
            return send(ControlRequest::Show, false);
        }
        Err(err) => return fail(err),
    };

    // Without the port no browser can reach Desktop, so there's nothing to
    // run. Where there's no control socket (Windows), this also stops a second
    // Desktop.
    let listener = match Server::bind() {
        Ok(listener) => listener,
        Err(err) => {
            return fail(bind_failure(
                &err,
                platform::listener_owner(server::DEFAULT_PORT),
            ));
        }
    };
    let discord_client_id = settings
        .discord_client_id
        .clone()
        .unwrap_or_else(|| discord::PAROUSIA_CLIENT_ID.to_string());
    let hub = Arc::new(Hub::new(settings, config_path, server::ADDRESS.to_string()));
    hub.set_debug(debug);
    hub.add_adapter(Box::new(DiscordAdapter::new(
        discord_client_id,
        hub.reporter(),
    )));
    {
        let server = Server::new(Arc::clone(&hub));
        thread::spawn(move || server.serve(listener));
    }
    if debug {
        println!("Parousia Desktop listening on {}", server::ADDRESS);
    }
    platform::control::start(control_server, Arc::clone(&hub));
    if debug {
        println!(
            "Parousia Desktop: settings in {}",
            paths.config_path().display()
        );
    }

    if std::io::stdin().is_terminal() {
        console::spawn(Arc::clone(&hub), quit);
    }
    if with_tray {
        match platform::run_tray(Arc::clone(&hub)) {
            Some(TrayExit::Quit) => quit(),
            Some(TrayExit::Unavailable(reason)) if hub.debug() => eprintln!(
                "parousia-desktop: no tray ({reason}); still running. Use `Parousia-Desktop status`."
            ),
            Some(TrayExit::Unavailable(_)) | None => {}
        }
    }
    loop {
        thread::park();
    }
}

fn quit() -> ! {
    platform::control::release();
    std::process::exit(0)
}

fn send(request: ControlRequest, json: bool) -> ExitCode {
    match platform::control::send(&request) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn a_taken_port_says_which_and_what_to_do() {
        let message = bind_failure(
            &Error::from(ErrorKind::AddrInUse),
            platform::Owner::ThisUser,
        );
        assert!(message.contains("57179"));
        assert!(message.contains("already in use"));
        assert!(message.contains("Close whatever is using 127.0.0.1:57179"));
    }

    #[test]
    fn a_port_another_user_holds_is_called_out() {
        let message = bind_failure(
            &Error::from(ErrorKind::AddrInUse),
            platform::Owner::OtherUser,
        );
        assert!(message.contains("another user"), "{message}");
        assert!(message.contains("127.0.0.1:57179"));
    }

    #[test]
    fn any_other_failure_keeps_its_reason() {
        let message = bind_failure(
            &Error::new(ErrorKind::PermissionDenied, "denied"),
            platform::Owner::Unknown,
        );
        assert!(message.contains("denied"));
        assert!(message.contains("127.0.0.1:57179"));
    }
}
