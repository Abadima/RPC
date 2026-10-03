//! The tray menu (`platform/tray_menu.rs`) as dbusmenu properties and
//! layouts.

use super::dbus::Value;
use crate::platform::tray_menu::Item;

/// dbusmenu treats `_` as a mnemonic marker; a literal one is doubled.
fn escape_label(label: &str) -> String {
    label.replace('_', "__")
}

pub fn properties(item: &Item, filter: &[String]) -> Value {
    let wanted = |name: &str| filter.is_empty() || filter.iter().any(|f| f == name);
    let mut entries = Vec::new();
    if item.separator {
        if wanted("type") {
            entries.push(("type", Value::str("separator")));
        }
    } else if wanted("label") {
        entries.push(("label", Value::Str(escape_label(&item.label))));
    }
    if !item.enabled && wanted("enabled") {
        entries.push(("enabled", Value::Bool(false)));
    }
    if let Some(checked) = item.checked {
        if wanted("toggle-type") {
            entries.push(("toggle-type", Value::str("checkmark")));
        }
        if wanted("toggle-state") {
            entries.push(("toggle-state", Value::I32(i32::from(checked))));
        }
    }
    if !item.children.is_empty() && wanted("children-display") {
        entries.push(("children-display", Value::str("submenu")));
    }
    Value::dict(entries)
}

/// `(ia{sv}av)`, recursing `depth` levels (`None` for all of them).
pub fn layout(item: &Item, depth: Option<usize>, filter: &[String]) -> Value {
    let children = match depth {
        Some(0) => Vec::new(),
        _ => item
            .children
            .iter()
            .map(|child| Value::variant(layout(child, depth.map(|d| d - 1), filter)))
            .collect(),
    };
    Value::Struct(vec![
        Value::I32(item.id),
        properties(item, filter),
        Value::Array("v".into(), children),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::hub::tests::test_hub;
    use crate::platform::tray_menu::build;

    #[test]
    fn checkmarks_and_submenus_are_marked_for_the_host() {
        let item = Item {
            id: 99,
            label: "my_setting".into(),
            enabled: true,
            separator: false,
            checked: Some(true),
            children: Vec::new(),
        };
        assert_eq!(
            properties(&item, &[]),
            Value::dict(vec![
                ("label", Value::str("my__setting")),
                ("toggle-type", Value::str("checkmark")),
                ("toggle-state", Value::I32(1)),
            ])
        );
        let menu = build(&test_hub().status());
        let Value::Struct(fields) = layout(&menu, Some(0), &[]) else {
            panic!()
        };
        assert_eq!(fields[2], Value::Array("v".into(), vec![]));
    }
}
