from __future__ import annotations

import logging
import re
import tomllib
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_core.prompting import (
    PromptError,
    build_system_prompt,
    build_wrapup_message,
    environment_text,
    fallback_question,
    load,
    parse_skill,
    placeholders,
    render,
    skills,
    tool_names,
    validate_prompts,
)
from agent_core.tools.cli_tools import KubectlGetPodsTool, KubectlPodDiagnosticsTool
from agent_core.tools.rag import SearchKnowledgeBaseTool

AGENT_CORE_DIR = Path(__file__).resolve().parent.parent
PACKAGE_DIR = Path(str(files("agent_core")))
NOW = datetime(2026, 7, 18, 10, 30, 0, tzinfo=timezone.utc)

# Size of the hand-written prompt this refactor replaced, rendered with the
# same time anchor: the composed prompt for the full production tool set must
# never grow past it, because it is resent on every LLM call.
LEGACY_PROMPT_CHARS = 2245
LEGACY_PROMPT_WORDS = 347

OTEL_DEMO_FALLBACK_QUESTION = (
    "Customers are reporting errors during checkout in the OpenTelemetry "
    "Demo Store (namespace otel-demo). Diagnose the root cause using the "
    "available metrics, logs, and pod status."
)


def _env_example() -> dict[str, str]:
    values = {}
    for line in (AGENT_CORE_DIR / ".env.example").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def _grafana_tools() -> list[SimpleNamespace]:
    env = _env_example()
    prefix = env["MCP_GRAFANA_TOOL_PREFIX"]
    remote_names = [n.strip() for n in env["MCP_GRAFANA_TOOL_ALLOWLIST"].split(",") if n.strip()]
    return [
        SimpleNamespace(name=prefix + n, remote_name=n, description="", parameters_schema={})
        for n in remote_names
    ]


def _kubectl_tools() -> list:
    return [KubectlGetPodsTool(), KubectlPodDiagnosticsTool()]


def _production_tools() -> list:
    return [*_grafana_tools(), *_kubectl_tools(), SearchKnowledgeBaseTool("http://rag")]


def _builtin_environments() -> list[str]:
    return sorted(
        path.parent.name for path in (PACKAGE_DIR / "environments").glob("*/environment.md")
    )


def _write_environment(folder: Path, text: str) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "environment.md").write_text(text, encoding="utf-8")
    return str(folder)


# --- front matter ------------------------------------------------------------


def test_parse_skill_reads_requires_any_and_body():
    skill = parse_skill(
        "---\nrequires_any: a, b\n---\nTitle:\n- rule", "prompts/skills/demo.md"
    )

    assert skill.name == "demo"
    assert skill.requires_any == ("a", "b")
    assert skill.body == "Title:\n- rule"


@pytest.mark.parametrize(
    "text",
    [
        "Title:\n- no front matter",
        "---\nrequires_any: a\nTitle:\n- unterminated",
        "---\nrequires_any:\n---\nbody",
        "---\nrequires_any: a\norder: 1\n---\nbody",
        "---\n---\nbody",
    ],
)
def test_parse_skill_rejects_malformed_front_matter(text):
    with pytest.raises(PromptError, match="demo.md"):
        parse_skill(text, "prompts/skills/demo.md")


def test_front_matter_outside_skills_is_rejected(tmp_path):
    env = _write_environment(tmp_path / "env", "---\nrequires_any: a\n---\nEnvironment: x")

    with pytest.raises(PromptError, match="front matter"):
        environment_text(env)


# --- render ------------------------------------------------------------------


def test_render_uses_the_registered_tool_name():
    rendered = render(
        "Run {{tool:query_prometheus}} first.",
        tools={"query_prometheus": "grafana_query_prometheus"},
    )

    assert rendered == "Run grafana_query_prometheus first."


def test_render_drops_lines_for_missing_tools_and_none_values():
    template = "keep\nuse {{tool:absent}}\nnamespaces: {{namespaces}}\nend"

    assert render(template, values={"namespaces": None}) == "keep\nend"


def test_render_rejects_unknown_and_malformed_placeholders():
    with pytest.raises(PromptError):
        render("{{foo}}")
    with pytest.raises(PromptError):
        render("{{tool}}")
    with pytest.raises(PromptError):
        render("{{now:x}}", values={"now": "t"})


def test_render_leaves_query_and_template_braces_untouched():
    text = '{namespace="otel-demo"}\n{"a": {"b": 1}}\n{{ $labels.pod }}'

    assert render(text) == text


def test_render_never_rescans_substituted_values():
    rendered = render("{{alerts}}", values={"alerts": "{{now}}\n{x}"})

    assert rendered == "{{now}}\n{x}"


# --- real files --------------------------------------------------------------

SYSTEM_PART_PLACEHOLDERS = {"now", "max_turns", "namespaces", "tool"}
# file -> (placeholders it may use, substrings it must contain)
CONTRACT = {
    "core": (
        SYSTEM_PART_PLACEHOLDERS,
        ["never infer the current time", "{{now}}", "{{max_turns}}"],
    ),
    "answer": (set(), ["Final answer", "Not verified"]),
    "wrapup": ({"answer", "tool"}, ["reached the tool-call budget", "{{answer}}"]),
    "report": (
        set(),
        ['"title"', '"summary"', '"error_sources"', '"problem"', '"remediations"', "[KB1]"],
    ),
    "incident": (
        {"source", "alerts"},
        ["currently firing", "alert labels/annotations", "{{source}}", "{{alerts}}"],
    ),
    "fallback_question": (set(), []),
}
SKILL_CONTRACT = {
    "grafana": ["RFC3339", "{{tool:list_datasources}}", "{{tool:alerting_manage_rules}}"],
    "kubernetes": ["{{namespaces}}"],
    "knowledge_base": ["[KB1]", "{{tool:search_knowledge_base}}"],
}


@pytest.mark.parametrize("name", sorted(CONTRACT))
def test_prompt_file_matches_contract(name):
    allowed, phrases = CONTRACT[name]
    text = load(name)

    assert placeholders(text) <= allowed
    for phrase in phrases:
        assert phrase in text
    assert "doc_id" not in text


def test_skills_match_contract():
    by_name = {skill.name: skill for skill in skills()}

    assert set(by_name) == set(SKILL_CONTRACT)
    for name, phrases in SKILL_CONTRACT.items():
        body = by_name[name].body
        assert placeholders(body) <= SYSTEM_PART_PLACEHOLDERS
        for phrase in phrases:
            assert phrase in body
        assert "doc_id" not in body


def test_answer_names_every_heading():
    for heading in ("Root cause", "Evidence", "Not verified", "Actions"):
        assert heading in load("answer")


def test_wrapup_keeps_kb_markers_on_a_gated_line():
    assert any(
        "[KBn] source markers" in line and "{{tool:search_knowledge_base}}" in line
        for line in load("wrapup").splitlines()
    )


def test_every_tool_placeholder_names_a_production_tool():
    # A typo in {{tool:x}} would otherwise drop its line from every prompt silently.
    production = set(tool_names(_production_tools()))
    texts = [load("wrapup"), *(skill.body for skill in skills())]
    texts += [environment_text(env) for env in _builtin_environments()]

    used = {name for text in texts for name in re.findall(r"\{\{\s*tool:([a-z0-9_]+)", text)}

    assert used
    assert used <= production, sorted(used - production)


def test_otel_demo_environment_files():
    assert "otel-demo" in environment_text("otel-demo")
    assert placeholders(environment_text("otel-demo")) <= SYSTEM_PART_PLACEHOLDERS
    assert fallback_question("otel-demo") == OTEL_DEMO_FALLBACK_QUESTION


# --- production composition ----------------------------------------------------


def test_production_prompt_names_only_registered_tools_and_fits_the_budget():
    tools = _production_tools()
    registered = {tool.name for tool in tools}

    prompt = build_system_prompt(
        tools, environment="otel-demo", namespaces={"otel-demo"}, now=NOW
    )

    for phrase in ("2026-07-18T10:30:00Z", "never infer the current time", "RFC3339",
                   "grafana_list_datasources", "[KB1]", "otel-demo"):
        assert phrase in prompt
    assert "doc_id" not in prompt
    assert "{{" not in prompt
    named = set(re.findall(r"\b(grafana_\w+|kubectl_\w+|search_knowledge_base)\b", prompt))
    assert named <= registered
    # Unprefixed MCP names are tools the model does not have.
    assert re.search(
        r"(?<!grafana_)\b(list_datasources|query_prometheus|list_loki_label_values)\b", prompt
    ) is None
    assert len(prompt) <= LEGACY_PROMPT_CHARS
    assert len(prompt.split()) <= LEGACY_PROMPT_WORDS


def test_system_prompt_logs_size_and_skills(caplog):
    with caplog.at_level(logging.INFO, logger="agent_core.prompting"):
        build_system_prompt(_kubectl_tools(), now=NOW)

    assert "skills=['kubernetes']" in caplog.text
    assert "environment=(generic)" in caplog.text
    assert "tool schemas:" in caplog.text


# --- gating --------------------------------------------------------------------


def test_knowledge_base_text_needs_the_search_tool():
    tools = [*_grafana_tools(), *_kubectl_tools()]

    assert "[KB" not in build_system_prompt(tools, now=NOW)
    assert "[KB" not in build_wrapup_message(tools)
    assert "[KBn] source markers" in build_wrapup_message([SearchKnowledgeBaseTool("http://rag")])


def test_kubernetes_text_needs_the_kubectl_tools():
    tools = [*_grafana_tools(), SearchKnowledgeBaseTool("http://rag")]

    assert "kubectl" not in build_system_prompt(tools, namespaces={"otel-demo"}, now=NOW)


def test_namespace_line_is_dropped_without_an_allowlist():
    with_allowlist = build_system_prompt(_kubectl_tools(), namespaces={"b", "a"}, now=NOW)
    without = build_system_prompt(_kubectl_tools(), now=NOW)

    assert "a, b" in with_allowlist
    assert "a, b" not in without


def test_prompt_without_tools_is_core_then_answer():
    values = {"now": "2026-07-18T10:30:00Z", "max_turns": "12", "namespaces": None}

    prompt = build_system_prompt(now=NOW)

    assert prompt.startswith(render(load("core"), values=values).splitlines()[0])
    assert prompt.endswith(load("answer"))


def test_wrapup_restates_the_answer_contract():
    assert "Final answer" in build_wrapup_message()


# --- environments --------------------------------------------------------------


def test_generic_prompt_has_no_infrastructure_facts():
    prompt = build_system_prompt(_production_tools(), now=NOW)

    assert environment_text("") == ""
    assert "Environment:" not in prompt
    assert "otel-demo" not in prompt


@pytest.mark.parametrize("environment", _builtin_environments())
def test_generic_files_hold_no_environment_identifiers(environment):
    # Identifiers (names with - or _) and product names from an environment
    # profile must not leak into the generic prompts/ layer.
    env_text = environment_text(environment) + "\n" + fallback_question(environment)
    identifiers = set(re.findall(r"[A-Za-z0-9]+[-_][A-Za-z0-9_-]+|OpenTelemetry", env_text))
    generic = "\n".join(
        path.read_text(encoding="utf-8") for path in (PACKAGE_DIR / "prompts").rglob("*.md")
    )

    assert identifiers
    assert {i for i in identifiers if i in generic} == set()


def test_builtin_environment_is_included():
    prompt = build_system_prompt(environment="otel-demo", now=NOW)

    assert environment_text("otel-demo").splitlines()[0] in prompt


def test_environment_directory_without_fallback_question(tmp_path):
    env = _write_environment(tmp_path / "my-env", "Environment: lab cluster.")

    assert "Environment: lab cluster." in build_system_prompt(environment=env, now=NOW)
    assert fallback_question(env) == load("fallback_question")


def test_unknown_environment_is_rejected():
    with pytest.raises(PromptError, match="otel-demo"):
        environment_text("nope")
    with pytest.raises(PromptError):
        environment_text("../x")


def test_fallback_question_defaults_to_the_generic_one():
    assert fallback_question("") == load("fallback_question")


@pytest.mark.parametrize("environment", _builtin_environments())
def test_validate_prompts_accepts_every_builtin_environment(environment):
    validate_prompts(environment)


def test_validate_prompts_accepts_the_shipped_files(caplog):
    with caplog.at_level(logging.WARNING, logger="agent_core.prompting"):
        validate_prompts("otel-demo")
    assert not caplog.records

    with caplog.at_level(logging.WARNING, logger="agent_core.prompting"):
        validate_prompts("")
    assert "AGENT_ENVIRONMENT is empty" in caplog.text


def test_validate_prompts_rejects_a_placeholder_not_allowed_in_the_file(tmp_path):
    env = _write_environment(tmp_path / "bad-env", "Environment: {{alerts}}")

    with pytest.raises(PromptError, match="environment.md"):
        validate_prompts(env)


# --- size, style and packaging -------------------------------------------------

WORD_CAPS = {"core": 150, "answer": 40}
SKILL_WORD_CAP = 120
ENVIRONMENT_WORD_CAP = 250


def test_prompt_files_stay_within_word_caps():
    for name, cap in WORD_CAPS.items():
        assert len(load(name).split()) <= cap, name
    for skill in skills():
        assert len(skill.body.split()) <= SKILL_WORD_CAP, skill.name
    for environment in _builtin_environments():
        assert len(environment_text(environment).split()) <= ENVIRONMENT_WORD_CAP, environment


def _content_files() -> list[Path]:
    return sorted(
        path
        for folder in ("prompts", "environments")
        for path in (PACKAGE_DIR / folder).rglob("*")
        if path.is_file()
    )


def test_prompt_text_is_vendor_neutral():
    vendor = re.compile(r"(?i)\b(anthropic|openai|gpt|claude|llama|ollama)\b")
    for path in _content_files():
        text = path.read_text(encoding="utf-8")
        assert "```" not in text, path
        assert re.search(r"<[A-Za-z/][^>]*>", text) is None, path
        assert "Human:" not in text and "Assistant:" not in text, path
        assert vendor.search(text) is None, path


def test_every_prompt_file_is_packaged():
    pyproject = tomllib.loads((AGENT_CORE_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    globs = pyproject["tool"]["setuptools"]["package-data"]["agent_core"]

    # Path.glob, like setuptools, never lets "*" cross a "/" (fnmatch would).
    packaged = {path for pattern in globs for path in PACKAGE_DIR.glob(pattern)}

    files_found = _content_files()
    assert files_found
    assert set(files_found) <= packaged, sorted(
        path.relative_to(PACKAGE_DIR).as_posix() for path in set(files_found) - packaged
    )
