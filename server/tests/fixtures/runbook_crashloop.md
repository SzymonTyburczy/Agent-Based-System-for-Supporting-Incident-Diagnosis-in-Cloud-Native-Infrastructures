# Runbook: CrashLoopBackOff

Pod aplikacji restartuje się w pętli. Ten runbook prowadzi przez diagnozę
i najczęstsze przyczyny.

## Diagnoza

Sprawdź stan podów w namespace demo:

```bash
kubectl get pods -n otel-demo
kubectl describe pod <nazwa-poda> -n otel-demo
```

Typowe przyczyny to błędna konfiguracja, brak zasobów albo nieudany probe
startowy.

### Logi kontenera

Pobierz logi poprzedniej instancji kontenera i porównaj limity pamięci
z faktycznym zużyciem:

```yaml
# przykładowa konfiguracja limitów — znak # w YAML-u to nie nagłówek Markdown
resources:
  limits:
    memory: "512Mi"

  requests:
    memory: "256Mi"
# koniec przykładu
```

Kod wyjścia 137 oznacza OOMKilled.

## Kody wyjścia

| Kod | Znaczenie                 |
| --- | ------------------------- |
| 137 | OOMKilled (limit pamięci) |
| 1   | błąd aplikacji            |

## Znane obejścia

Zwiększ limity pamięci albo napraw konfigurację startową. Po zmianie
obserwuj restarty przez co najmniej pięć minut.
