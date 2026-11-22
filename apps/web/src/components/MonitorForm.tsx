import { useRef, useState, type FormEvent } from 'react';
import type { CreateMonitorInput, InstructionInterpretation, MonitorDto } from '@monitorly/contracts';
import {
  CHECK_INTERVAL_OPTIONS,
  FETCH_MODES,
  MONITOR_TYPES,
  type MonitorFetchMode,
  type MonitorType,
} from '@monitorly/contracts/constants';
import { useInterpretInstruction } from '../hooks/useMonitors';
import { ApiError } from '../lib/api';
import { FETCH_MODE_LABELS, MONITOR_TYPE_LABELS, describeRules, formatInterval, splitList } from '../lib/format';
import { Alert, Button, Card, Checkbox, SelectField, TextAreaField, TextField } from './ui';

interface Props {
  initial?: MonitorDto;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (values: Required<Omit<CreateMonitorInput, 'name'>> & { name: string }) => void;
  onCancel?: () => void;
}

const fieldErrorsOf = (error: Error | null) => (error instanceof ApiError ? error.fieldErrors : {});

export function MonitorForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: Props) {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [instruction, setInstruction] = useState(initial?.instruction ?? '');
  const [monitorType, setMonitorType] = useState<MonitorType>(initial?.monitorType ?? 'job_listing');
  const [keywords, setKeywords] = useState(initial?.rules.keywords.join(', ') ?? '');
  const [locations, setLocations] = useState(initial?.rules.locations.join(', ') ?? '');
  const [excludeKeywords, setExcludeKeywords] = useState(initial?.rules.excludeKeywords.join(', ') ?? '');
  const [checkIntervalMinutes, setCheckInterval] = useState(initial?.checkIntervalMinutes ?? 30);
  const [fetchMode, setFetchMode] = useState<MonitorFetchMode>(initial?.fetchMode ?? 'auto');
  const [notifyInApp, setNotifyInApp] = useState(initial?.notifyInApp ?? true);
  const [notifyEmail, setNotifyEmail] = useState(initial?.notifyEmail ?? false);
  const [aiReview, setAiReview] = useState(initial?.aiReview ?? true);

  // ---- AI: description → suggested filters, which the user reviews before saving
  const interpret = useInterpretInstruction();
  /** The description the current filters were suggested from, plus what the filters couldn't capture. */
  const [suggestion, setSuggestion] = useState<{ instruction: string; notes: string[] } | null>(null);
  const [filtersTouched, setFiltersTouched] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);

  const trimmedInstruction = instruction.trim();
  // A 400 means the description itself is invalid (shown on the field); anything else means the AI is unavailable.
  const aiError = interpret.error instanceof ApiError && interpret.error.status === 400 ? null : interpret.error;
  // New monitors get a review step: the first submit suggests filters instead of saving.
  // Skipped if the user already filled the filters in themselves, or the AI is unavailable.
  const needsReview = !initial && !suggestion && !filtersTouched && !aiError;
  const filtersBasis = suggestion?.instruction ?? initial?.instruction;
  const descriptionChanged = filtersBasis !== undefined && trimmedInstruction !== filtersBasis && trimmedInstruction.length >= 5;

  const applySuggestion = (result: InstructionInterpretation, from: string) => {
    setMonitorType(result.monitorType);
    setKeywords(result.rules.keywords.join(', '));
    setLocations(result.rules.locations.join(', '));
    setExcludeKeywords(result.rules.excludeKeywords.join(', '));
    setSuggestion({ instruction: from, notes: result.notes });
    setFiltersTouched(false);
    filtersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const suggestFilters = () => {
    const from = trimmedInstruction;
    interpret.mutate(
      { instruction: from, url: url.trim() || undefined },
      { onSuccess: ({ interpretation }) => applySuggestion(interpretation, from) },
    );
  };

  /** Wraps a filter setter so manual edits are remembered. */
  const touched =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setFiltersTouched(true);
    };

  const fieldErrors = { ...fieldErrorsOf(interpret.error), ...fieldErrorsOf(error) };
  const formError = error && Object.keys(fieldErrorsOf(error)).length === 0 ? error.message : null;

  // Keep a custom interval (set via the API) selectable when editing.
  const intervalOptions = [...new Set<number>([...CHECK_INTERVAL_OPTIONS, checkIntervalMinutes])].sort((a, b) => a - b);

  const rules = { keywords: splitList(keywords), locations: splitList(locations), excludeKeywords: splitList(excludeKeywords) };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (needsReview) {
      suggestFilters();
      return;
    }
    onSubmit({
      url: url.trim(),
      name: name.trim(),
      instruction: trimmedInstruction,
      monitorType,
      rules,
      checkIntervalMinutes,
      fetchMode,
      notifyInApp,
      notifyEmail,
      aiReview,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {formError && <Alert>{formError}</Alert>}

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Website</h2>
        <TextField
          label="Website URL"
          type="url"
          placeholder="https://careers.example.com/jobs"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          error={fieldErrors.url}
          hint="The exact page to watch, e.g. the job listings page — not just the homepage."
          required
        />
        <TextField
          label="Name (optional)"
          placeholder="Acme internships"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          hint="Defaults to the website’s domain."
        />
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">What should we watch for?</h2>
        <TextAreaField
          label="Describe it in your own words"
          rows={3}
          placeholder="Notify me when a new Software Engineer Intern role is posted in India. Ignore senior positions."
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value);
            if (interpret.isError) interpret.reset();
          }}
          error={fieldErrors.instruction}
          hint={!initial && !suggestion ? 'We’ll turn this into filters for you to check before anything is saved.' : undefined}
          required
        />

        <div
          ref={filtersRef}
          className={
            suggestion
              ? 'space-y-4 rounded-lg bg-indigo-50/60 p-4 ring-1 ring-indigo-200'
              : 'space-y-4 rounded-lg bg-slate-50 p-4'
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-lg text-sm text-slate-600">
              {suggestion ? (
                <>
                  <span className="font-medium text-indigo-800">Suggested from your description.</span> Check the filters
                  and adjust anything that’s off — they’re what decides whether you get an alert.
                </>
              ) : (
                <>
                  <span className="font-medium text-slate-800">Filters.</span> Separate entries with commas. Leave them empty
                  to hear about every new item on the page.
                </>
              )}
            </p>
            <Button
              variant="secondary"
              onClick={suggestFilters}
              loading={interpret.isPending}
              disabled={trimmedInstruction.length < 5}
            >
              {suggestion || initial ? 'Update from description' : 'Fill in from description'}
            </Button>
          </div>

          {aiError && <Alert>{aiError.message}</Alert>}
          {descriptionChanged && !interpret.isPending && (
            <Alert tone="info">
              You changed the description. Click “Update from description” to refresh the filters, or edit them yourself.
            </Alert>
          )}
          {suggestion && suggestion.notes.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
              <p className="font-medium">Not covered by the filters:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {suggestion.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          <SelectField
            label="Type of page"
            value={monitorType}
            onChange={(e) => touched(setMonitorType)(e.target.value as MonitorType)}
          >
            {MONITOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {MONITOR_TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Must mention"
              placeholder="software engineer, intern"
              value={keywords}
              onChange={(e) => touched(setKeywords)(e.target.value)}
              error={fieldErrors.rules}
              hint="All of these"
            />
            <TextField
              label="Locations"
              placeholder="India, Remote"
              value={locations}
              onChange={(e) => touched(setLocations)(e.target.value)}
              hint="Any one of these"
            />
            <TextField
              label="Ignore if it mentions"
              placeholder="senior, principal"
              value={excludeKeywords}
              onChange={(e) => touched(setExcludeKeywords)(e.target.value)}
              hint="Any one of these"
            />
          </div>
          <p className="text-sm font-medium text-slate-800" aria-live="polite">
            {describeRules(monitorType, rules)}
          </p>
        </div>
      </Card>

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Schedule and alerts</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Check"
            value={checkIntervalMinutes}
            onChange={(e) => setCheckInterval(Number(e.target.value))}
            error={fieldErrors.checkIntervalMinutes}
          >
            {intervalOptions.map((m) => (
              <option key={m} value={m}>
                {formatInterval(m)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="How to load the page"
            value={fetchMode}
            onChange={(e) => setFetchMode(e.target.value as MonitorFetchMode)}
            hint="Automatic tries the fast method first and switches to a full browser if needed."
          >
            {FETCH_MODES.map((m) => (
              <option key={m} value={m}>
                {FETCH_MODE_LABELS[m]}
              </option>
            ))}
          </SelectField>
        </div>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium text-slate-800">Notify me by</legend>
          <Checkbox label="In-app notification" checked={notifyInApp} onChange={(e) => setNotifyInApp(e.target.checked)} />
          <Checkbox label="Email" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} />
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium text-slate-800">Before alerting me</legend>
          <Checkbox
            label="AI review of matches"
            description="Before alerting you, AI checks each change that passes your filters against your description and writes a one-line summary. Uses the AI provider’s quota; if AI is unavailable, the filters alone decide."
            checked={aiReview}
            onChange={(e) => setAiReview(e.target.checked)}
          />
        </fieldset>
      </Card>

      <div className="flex justify-end gap-3">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={pending || (needsReview && interpret.isPending)}>
          {needsReview ? 'Next: review filters' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
