//! A per-run budget change through `modes.update`. It uses the same range as
//! a definition's `budget`; a new run always starts with its definition's.

use serde::Deserialize;
use serde_json::Value;

use super::model::MAX_SAFE_INTEGER;
use super::snapshot::{MAX_TURNS, MIN_TOKENS};

/// App settings field (`AppSettings.goalBudget`).
pub const GOAL_BUDGET_SETTING: &str = "goalBudget";

/// `{ maxTurns, maxTokens }`; `null` is unlimited. Both fields are required
/// so a client never clears a limit by omitting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunBudget {
    #[serde(deserialize_with = "nullable")]
    pub max_turns: Option<i64>,
    #[serde(deserialize_with = "nullable")]
    pub max_tokens: Option<i64>,
}

fn nullable<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(deserializer)
}

impl RunBudget {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .max_turns
            .is_some_and(|turns| !(1..=MAX_TURNS).contains(&turns))
        {
            return Err("maxTurns must be between 1 and 10000, or null");
        }
        if self
            .max_tokens
            .is_some_and(|tokens| !(MIN_TOKENS..=MAX_SAFE_INTEGER).contains(&tokens))
        {
            return Err("maxTokens must be at least 1000, or null");
        }
        Ok(())
    }
}

fn parse(value: &Value) -> Result<RunBudget, String> {
    let budget: RunBudget =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    budget.validate()?;
    Ok(budget)
}

/// `settings.set` check for `goalBudget`: absent, `null`, or a valid budget.
pub fn validate_goal_budget_setting(settings: &Value) -> Result<(), String> {
    match settings.get(GOAL_BUDGET_SETTING) {
        None | Some(Value::Null) => Ok(()),
        Some(value) => parse(value)
            .map(|_| ())
            .map_err(|error| format!("{GOAL_BUDGET_SETTING}: {error}")),
    }
}
