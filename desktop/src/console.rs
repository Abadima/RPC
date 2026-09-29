//! Commands typed into the terminal Desktop runs in. Only started when stdin
//! is a terminal, so it's never listening to a pipe someone else controls.

use std::io::{self, BufRead};
use std::sync::Arc;
use std::thread;

use crate::control::{self, ControlRequest};
use crate::hub::{Hub, Setting};

const HELP: &str =
    "Commands: status, allow <origin>, disallow <origin>, userscripts on|off, debug on|off, quit";

pub fn spawn(hub: Arc<Hub>, quit: fn() -> !) {
    thread::spawn(move || {
        println!("{HELP}");
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let words: Vec<&str> = line.split_whitespace().collect();
            let request = match words.as_slice() {
                [] => continue,
                ["status"] => ControlRequest::Status,
                ["allow", origin] => ControlRequest::Allow {
                    origin: (*origin).to_string(),
                },
                ["disallow", origin] => ControlRequest::Disallow {
                    origin: (*origin).to_string(),
                },
                ["userscripts", value @ ("on" | "off")] => ControlRequest::Set {
                    setting: Setting::AllowUserscripts,
                    value: *value == "on",
                },
                ["debug", value @ ("on" | "off")] => ControlRequest::Debug { on: *value == "on" },
                ["quit" | "exit"] => quit(),
                _ => {
                    println!("{HELP}");
                    continue;
                }
            };
            println!("{}", control::describe(&control::handle(request, &hub)));
        }
    });
}
