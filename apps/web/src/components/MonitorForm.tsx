import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { createMonitorSchema, type CreateMonitorInput, type InstructionInterpretation, type MonitorDto } from '@monitorly/contracts/api';
import {
  CHECK_INTERVAL_OPTIONS,
  FETCH_MODES,
  MONITOR_TYPES,
  type MonitorFetchMode,
  type MonitorType,
} from '@monitorly/contracts/constants';
import { useMe } from '../hooks/useAuth';
import { useInterpretInstruction } from '../hooks/useMonitors';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { ApiError } from '../lib/api';
import { FETCH_MODE_LABELS, MONITOR_TYPE_LABELS, describeRules, formatInterval, splitList } from '../lib/format';
import { focusFirstInvalid, urlError, validate } from '../lib/validation';
import { Alert, Button, Card, Checkbox, SelectField, TextAreaField, TextField, UnsavedChangesDialog } from './ui';

export type MonitorFormValues = Required<Omit<CreateMonitorInput, 'name'>> & { name: string };

interface Props {
  initial?: MonitorDto;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  /** Resolve when saved (the page navigates away), reject when the save failed. */
  onSubmit: (values: MonitorFormValues) => Promise<unknown>;
  onCancel?: () => void;
}

const fieldErrorsOf = (error: Error | null) => (error instanceof ApiError ? error.fieldErrors : {});
const INSTRUCTION_MAX = 2000;

export function MonitorForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: Props) {
  const { data: me } = useMe();
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [instruction, setInstruction] = useState(initial?.instruction ?? '');
  const [monitorType, setMonitorType] = useState<MonitorType>(initial?.monitorType ?? 'job_listing');
  const [keywords, setKeywords] = useState(initial?.rules.keywords.join(', ') ?? '');
  const [locations, setLocations] = useState(initial?.rules.locations.join(', ') ?? '');
  const [excludeKeywords, setExcludeKeywords] = useState(initial?.rules.excludeKeywords.join(', ') ?? '');
  const [checkIntervalMinutes, setCheckInterval] = useState(initial?.checkIntervalMinutes ?? me?.defaultCheckIntervalMinutes ?? 30);
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

  // ---- Validation: the API's own schema runs here first. Errors show once a field was left
  // (blur) or after a submit attempt; server errors show until that field is edited again.
  const formRef = useRef<HTMLFormElement>(null);
  const [attempted, setAttempted] = useState(false);
  const [blurred, setBlurred] = useState<Set<string>>(new Set());
  const [editedSinceError, setEditedSinceError] = useState<{ error: unknown; fields: Set<string> }>({ error: null, fields: new Set() });
  const latestError = error ?? interpret.error;
  const markEdited = (field: string) =>
    setEditedSinceError((prev) => ({
      error: latestError,
      fields: new Set(prev.error === latestError ? [...prev.fields, field] : [field]),
    }));
  const blur = (field: string) => () => setBlurred((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));

  // Keep a custom interval (set via the API) selectable when editing.
  const intervalOptions = [...new Set<number>([...CHECK_INTERVAL_OPTIONS, checkIntervalMinutes])].sort((a, b) => a - b);

  const rules = { keywords: splitList(keywords), locations: splitList(locations), excludeKeywords: splitList(excludeKeywords) };

  const values: MonitorFormValues = {
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
  };
  const valuesKey = JSON.stringify(values);
  const clientErrors = useMemo(() => {
    const errors = validate(createMonitorSchema, JSON.parse(valuesKey));
    const bad = urlError(url);
    if (bad) errors.url = bad;
    return errors;
  }, [valuesKey, url]);

  const serverErrors = { ...fieldErrorsOf(interpret.error), ...fieldErrorsOf(error) };
  const edited = editedSinceError.error === latestError ? editedSinceError.fields : new Set<string>();
  const fieldError = (field: string) => {
    if (clientErrors[field] && (attempted || blurred.has(field))) return clientErrors[field];
    if (serverErrors[field] && !edited.has(field.split('.')[0]!)) return serverErrors[field];
    return undefined;
  };
  const formError = error && Object.keys(fieldErrorsOf(error)).length === 0 ? error.message : null;

  // ---- Unsaved changes: ask before leaving with edits.
  const initialValues = useRef(valuesKey);
  const dirty = valuesKey !== initialValues.current;
  const unsaved = useUnsavedChanges(dirty && !pending);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    // The AI step only needs a usable description and URL; everything else is checked on save.
    if (needsReview && !clientErrors.instruction && !clientErrors.url) {
      suggestFilters();
      return;
    }
    if (Object.keys(clientErrors).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    unsaved.allowNavigation();
    try {
      await onSubmit(values);
    } catch {
      unsaved.blockNavigation();
      focusFirstInvalid(formRef.current);
    }
  };

  // Top-level fields only ("rules", not also "rules.keywords").
  const invalidCount = attempted ? Object.keys(clientErrors).filter((k) => !k.includes('.')).length : 0;

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-6" noValidate aria-label={submitLabel}>
      <UnsavedChangesDialog blocker={unsaved.blocker} />
      {formError && <Alert>{formError}</Alert>}
      {invalidCount > 0 && (
        <Alert>
          {invalidCount === 1 ? 'One field needs' : `${invalidCount} fields need`} your attention before this can be saved.
        </Alert>
      )}

      <Card className="space-y-5">
        <h2 className="text-base font-semibold">Website</h2>
        <TextField
          label="Website URL"
          type="url"
          placeholder="https://careers.example.com/jobs"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            markEdited('url');
          }}
          onBlur={blur('url')}
          error={fieldError('url')}
          autoComplete="url"
          hint="The exact page to watch, e.g. the job listings page — not just the homepage."
          required
        />
        <TextField
          label="Name (optional)"
          placeholder="Acme internships"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            markEdited('name');
          }}
          onBlur={blur('name')}
          error={fieldError('name')}
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
            markEdited('instruction');
            if (interpret.isError) interpret.reset();
          }}
          onBlur={blur('instruction')}
          error={fieldError('instruction')}
          aside={
            <span aria-hidden="true" className={`text-xs ${instruction.length > INSTRUCTION_MAX ? 'font-medium text-red-700' : 'text-slate-500'}`}>
              {instruction.length}/{INSTRUCTION_MAX}
            </span>
          }
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
              onChange={(e) => {
                touched(setKeywords)(e.target.value);
                markEdited('rules');
              }}
              onBlur={blur('rules.keywords')}
              error={fieldError('rules.keywords')}
              hint="All of these"
            />
            <TextField
              label="Locations"
              placeholder="India, Remote"
              value={locations}
              onChange={(e) => {
                touched(setLocations)(e.target.value);
                markEdited('rules');
              }}
              onBlur={blur('rules.locations')}
              error={fieldError('rules.locations')}
              hint="Any one of these"
            />
            <TextField
              label="Ignore if it mentions"
              placeholder="senior, principal"
              value={excludeKeywords}
              onChange={(e) => {
                touched(setExcludeKeywords)(e.target.value);
                markEdited('rules');
              }}
              onBlur={blur('rules.excludeKeywords')}
              error={fieldError('rules.excludeKeywords')}
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
            error={fieldError('checkIntervalMinutes')}
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
          <Checkbox
            label="Email"
            checked={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.checked)}
            description={
              me?.emailNotifications === false ? (
                <>
                  Email alerts are turned off for your whole account, so none are sent. Turn them back on in{' '}
                  <Link to="/settings" className="font-medium text-indigo-700 underline">
                    Settings
                  </Link>
                  .
                </>
              ) : me ? (
                `Sent to ${me.email}.`
              ) : undefined
            }
          />
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
