"""Loads the LLM-facing text from Markdown files and composes the system
prompt from it.

All prompt wording lives in `agent_core/prompts/` (generic) and
`agent_core/environments/<name>/` (infrastructure facts); this module only
loads, gates and fills it in. Stdlib only, and nothing from `agent/`,
`llm/` or `config`, so every entry point (and the Docker build check) can
import it without side effects.

Templating is deliberately tiny: `{{name}}` and `{{tool:base}}`, replaced in
one regex pass per line. `str.format`/`string.Template` would choke on (or
silently rewrite) the PromQL, LogQL and JSON braces that prompt text and
alert data are full of.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from importlib.resources import files
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Iterable, Mapping

if TYPE_CHECKING:
    from importlib.resources.abc import Traversable

    from agent_core.tools.base import Tool

logger = logging.getLogger(__name__)

_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)(?::([a-z0-9_]+))?\s*\}\}")
_ENVIRONMENT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# Which placeholders each file may use; "tool" stands for any {{tool:x}}.
# answer.md has none because it is inserted raw into wrapup.md, where
# substituted values are never re-scanned.
_SYSTEM_PART_PLACEHOLDERS = frozenset({"now", "max_turns", "namespaces", "tool"})
_ALLOWED_PLACEHOLDERS: dict[str, frozenset[str]] = {
    "core": _SYSTEM_PART_PLACEHOLDERS,
    "answer": frozenset(),
    "wrapup": frozenset({"answer", "tool"}),
    "report": frozenset(),
    "incident": frozenset({"source", "alerts"}),
    "fallback_question": frozenset(),
}


class PromptError(ValueError):
    """A prompt file or AGENT_ENVIRONMENT is unusable; raised at startup."""


@dataclass(frozen=True)
class Skill:
    name: str
    requires_any: tuple[str, ...]
    body: str


def _root() -> Traversable:
    return files("agent_core")


def _read(resource: Traversable | Path, source: str) -> str:
    text = resource.read_text(encoding="utf-8").strip()
    if text.startswith("---"):
        raise PromptError(f"{source}: front matter is only allowed in prompts/skills/*.md")
    return text


def parse_skill(text: str, source: str) -> Skill:
    """Splits a skill file into its `requires_any` front matter and body."""
    lines = text.strip().splitlines()
    if not lines or lines[0].strip() != "---":
        raise PromptError(f"{source}: a skill must start with '---' front matter")
    try:
        end = next(i for i, line in enumerate(lines[1:], start=1) if line.strip() == "---")
    except StopIteration:
        raise PromptError(f"{source}: unterminated front matter") from None

    requires_any: tuple[str, ...] = ()
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, _, value = line.partition(":")
        if key.strip() != "requires_any":
            raise PromptError(f"{source}: unknown front matter key {key.strip()!r}")
        requires_any = tuple(name.strip() for name in value.split(",") if name.strip())
    if not requires_any:
        raise PromptError(f"{source}: 'requires_any' must list at least one tool")

    body = "\n".join(lines[end + 1 :]).strip()
    return Skill(name=PurePosixPath(source).stem, requires_any=requires_any, body=body)


@lru_cache
def load(name: str) -> str:
    """Returns the stripped text of prompts/<name>.md."""
    return _read(_root() / "prompts" / f"{name}.md", f"prompts/{name}.md")


@lru_cache
def skills() -> tuple[Skill, ...]:
    """Every prompts/skills/*.md, sorted by file stem."""
    folder = _root() / "prompts" / "skills"
    entries = sorted(
        (entry for entry in folder.iterdir() if entry.name.endswith(".md")),
        key=lambda entry: entry.name,
    )
    return tuple(
        parse_skill(entry.read_text(encoding="utf-8"), f"prompts/skills/{entry.name}")
        for entry in entries
    )


def _builtin_environments() -> list[str]:
    folder = _root() / "environments"
    return sorted(
        entry.name for entry in folder.iterdir() if (entry / "environment.md").is_file()
    )


def _is_path(environment: str) -> bool:
    return "/" in environment or os.sep in environment


def _environment_dir(environment: str) -> Traversable | Path | None:
    """Resolves AGENT_ENVIRONMENT: "" (generic), a directory path (anything
    with a path separator, e.g. a mounted ConfigMap), or a built-in name.
    """
    if not environment:
        return None
    if _is_path(environment):
        path = Path(environment)
        if not (path / "environment.md").is_file():
            raise PromptError(
                f"AGENT_ENVIRONMENT {environment!r} is not a directory containing environment.md"
            )
        return path
    builtin = _root() / "environments" / environment
    if not _ENVIRONMENT_NAME.fullmatch(environment) or not (builtin / "environment.md").is_file():
        raise PromptError(
            f"Unknown AGENT_ENVIRONMENT {environment!r}; built-in: {_builtin_environments()}"
        )
    return builtin


def _environment_source(environment: str, file_name: str) -> str:
    if _is_path(environment):
        return str(Path(environment) / file_name)
    return f"environments/{environment}/{file_name}"


# Cached: a ConfigMap edit therefore needs a rollout restart to take effect.
@lru_cache
def environment_text(environment: str) -> str:
    folder = _environment_dir(environment)
    if folder is None:
        return ""
    return _read(folder / "environment.md", _environment_source(environment, "environment.md"))


@lru_cache
def fallback_question(environment: str) -> str:
    """The run-once question used when nothing is firing: the environment's
    own one if it has it, else the generic one.
    """
    folder = _environment_dir(environment)
    if folder is not None and (folder / "fallback_question.md").is_file():
        return _read(
            folder / "fallback_question.md",
            _environment_source(environment, "fallback_question.md"),
        )
    return load("fallback_question")


def _parse_placeholder(match: re.Match[str]) -> tuple[str, str | None]:
    name, argument = match.group(1), match.group(2)
    if name == "tool" and argument is None:
        raise PromptError(f"{match.group(0)!r}: a tool placeholder needs a tool name")
    if name != "tool" and argument is not None:
        raise PromptError(f"{match.group(0)!r}: only 'tool' takes an argument")
    return name, argument


def placeholders(text: str) -> set[str]:
    """Placeholder names used in `text`; "tool" for any {{tool:x}}."""
    return {_parse_placeholder(match)[0] for match in _PLACEHOLDER.finditer(text)}


def tool_names(tools: Iterable[Tool]) -> dict[str, str]:
    """Maps each tool's base name (the MCP server's own name, without our
    prefix) to its registered name. On a collision the first entry wins.
    """
    names: dict[str, str] = {}
    for tool in tools:
        names.setdefault(getattr(tool, "remote_name", tool.name), tool.name)
    return names


def render(
    template: str,
    *,
    tools: Mapping[str, str] | None = None,
    values: Mapping[str, str | None] | None = None,
) -> str:
    """Fills placeholders line by line. A line whose tool is not registered,
    or whose value is None, is dropped, so the prompt never names a tool the
    model does not have. One re.sub pass per line: substituted values are
    never re-scanned, so they may contain braces, newlines or "{{".
    """
    tools = tools or {}
    values = values or {}
    rendered_lines = []
    for line in template.split("\n"):
        dropped = False

        def substitute(match: re.Match[str]) -> str:
            nonlocal dropped
            name, argument = _parse_placeholder(match)
            if name == "tool":
                if argument not in tools:
                    dropped = True
                    return ""
                return tools[argument]
            if name not in values:
                raise PromptError(f"No value for placeholder {match.group(0)!r}")
            value = values[name]
            if value is None:
                dropped = True
                return ""
            return value

        rendered = _PLACEHOLDER.sub(substitute, line)
        if not dropped:
            rendered_lines.append(rendered)
    return "\n".join(rendered_lines)


def build_system_prompt(
    tools: Iterable[Tool] = (),
    *,
    environment: str = "",
    max_turns: int = 12,
    namespaces: Iterable[str] | None = None,
    now: datetime | None = None,
) -> str:
    """Composes the one system message: core, the skills whose tools are
    registered, the environment profile, then the answer contract.

    `now` is injectable for tests; defaults to the real current time.
    """
    tools = list(tools)
    names = tool_names(tools)
    selected = [skill for skill in skills() if any(r in names for r in skill.requires_any)]

    parts = [load("core"), *(skill.body for skill in selected)]
    environment_part = environment_text(environment)
    if environment_part:
        parts.append(environment_part)
    parts.append(load("answer"))

    sorted_namespaces = sorted(namespaces or ())
    values = {
        "now": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "max_turns": str(max_turns),
        "namespaces": ", ".join(sorted_namespaces) if sorted_namespaces else None,
    }
    template = "\n\n".join(parts)
    prompt = re.sub(r"\n{3,}", "\n\n", render(template, tools=names, values=values)).strip()

    # The fingerprint hashes the unrendered text, so it identifies the prompt
    # version independently of the current time. Tool schemas are logged too
    # because they, not this text, dominate the per-call token cost.
    schema_chars = sum(
        len(
            json.dumps(
                {"name": t.name, "description": t.description, "parameters": t.parameters_schema},
                default=str,
            )
        )
        for t in tools
    )
    logger.info(
        "System prompt: %d chars, %d words, fingerprint=%s, skills=%s, environment=%s; "
        "tool schemas: %d chars",
        len(prompt),
        len(prompt.split()),
        hashlib.sha256(template.encode("utf-8")).hexdigest()[:12],
        [skill.name for skill in selected],
        environment or "(generic)",
        schema_chars,
    )
    return prompt


def build_wrapup_message(tools: Iterable[Tool] = ()) -> str:
    """The user message sent once the iteration budget runs out."""
    return render(load("wrapup"), tools=tool_names(tools), values={"answer": load("answer")})


def _check_placeholders(text: str, source: str, allowed: frozenset[str]) -> None:
    try:
        found = placeholders(text)
    except PromptError as exc:
        raise PromptError(f"{source}: {exc}") from None
    if found - allowed:
        raise PromptError(f"{source}: placeholders not allowed here: {sorted(found - allowed)}")


def validate_prompts(environment: str = "") -> None:
    """Loads every prompt file and checks its placeholders, so a missing file
    or a typo fails at startup (or in the Docker build), not mid-investigation.
    """
    for name, allowed in _ALLOWED_PLACEHOLDERS.items():
        _check_placeholders(load(name), f"prompts/{name}.md", allowed)
    for skill in skills():
        _check_placeholders(
            skill.body, f"prompts/skills/{skill.name}.md", _SYSTEM_PART_PLACEHOLDERS
        )

    if not environment:
        logger.warning(
            "AGENT_ENVIRONMENT is empty: using the generic prompt without infrastructure facts."
        )
        return
    _check_placeholders(
        environment_text(environment),
        _environment_source(environment, "environment.md"),
        _SYSTEM_PART_PLACEHOLDERS,
    )
    _check_placeholders(
        fallback_question(environment),
        _environment_source(environment, "fallback_question.md"),
        frozenset(),
    )
