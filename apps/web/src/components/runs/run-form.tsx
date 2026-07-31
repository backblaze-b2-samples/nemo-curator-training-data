"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import type { PiiEntity, RunConfig } from "@nemo-curator-training-data/shared";
import {
  DEDUP_MODE_OPTIONS,
  PII_ENTITY_OPTIONS,
  QUALITY_PRESET_OPTIONS,
  REDACTION_MODE_OPTIONS,
  SOURCE_OPTIONS,
} from "@/lib/run-options";

const schema = z
  .object({
    name: z.string().min(1, "Give the run a name").max(120),
    source: z.enum(["demo", "b2_prefix"]),
    source_prefix: z.string(),
    dedup_enabled: z.boolean(),
    quality_enabled: z.boolean(),
    pii_enabled: z.boolean(),
    dedup_mode: z.enum(["exact", "exact_fuzzy"]),
    quality_preset: z.enum(["lenient", "standard", "strict"]),
    pii_entities: z.array(
      z.enum([
        "EMAIL_ADDRESS",
        "PHONE_NUMBER",
        "PERSON",
        "US_SSN",
        "CREDIT_CARD",
        "IP_ADDRESS",
      ]),
    ),
    redaction_mode: z.enum(["replace", "mask", "hash"]),
  })
  .superRefine((values, ctx) => {
    if (values.source === "b2_prefix" && values.source_prefix.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_prefix"],
        message: "A B2 prefix is required for this source",
      });
    }
    if (values.pii_enabled && values.pii_entities.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pii_entities"],
        message: "Select at least one entity to redact",
      });
    }
  });

export type RunFormValues = z.infer<typeof schema>;

export function configToFormValues(name: string, config: RunConfig): RunFormValues {
  return {
    name,
    source: config.source,
    source_prefix: config.source_prefix ?? "",
    dedup_enabled: config.dedup_enabled,
    quality_enabled: config.quality_enabled,
    pii_enabled: config.pii_enabled,
    dedup_mode: config.dedup_mode,
    quality_preset: config.quality_preset,
    pii_entities: config.pii_entities,
    redaction_mode: config.redaction_mode,
  };
}

export function formValuesToConfig(values: RunFormValues): RunConfig {
  return {
    source: values.source,
    source_prefix:
      values.source === "b2_prefix" ? values.source_prefix.trim() : null,
    dedup_enabled: values.dedup_enabled,
    quality_enabled: values.quality_enabled,
    pii_enabled: values.pii_enabled,
    dedup_mode: values.dedup_mode,
    quality_preset: values.quality_preset,
    pii_entities: values.pii_entities,
    redaction_mode: values.redaction_mode,
  };
}

interface RunFormProps {
  defaultValues: RunFormValues;
  showHints: boolean;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (values: RunFormValues) => void;
  onCancel?: () => void;
}

export function RunForm({
  defaultValues,
  showHints,
  submitting,
  submitLabel,
  onSubmit,
  onCancel,
}: RunFormProps) {
  const form = useForm<RunFormValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  const source = form.watch("source");
  const dedupOn = form.watch("dedup_enabled");
  const qualityOn = form.watch("quality_enabled");
  const piiOn = form.watch("pii_enabled");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Name + source */}
        <Card>
          <CardHeader className="border-b border-border py-4 px-5">
            <CardTitle className="card-title">Corpus</CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Run name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Web crawl Q3 pretraining" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Source</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full sm:w-80">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SOURCE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showHints && (
                    <FormDescription>
                      Recommended: <strong>Demo corpus</strong> — a bundled ~40-doc
                      synthetic set that needs no upload and no key.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            {source === "b2_prefix" && (
              <FormField
                control={form.control}
                name="source_prefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>B2 prefix</FormLabel>
                    <FormControl>
                      <Input placeholder="uploads/my-crawl/" {...field} />
                    </FormControl>
                    <FormDescription>
                      Objects under this prefix (JSONL with a <code>text</code>{" "}
                      field, or plain text) are read as the raw corpus.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </CardContent>
        </Card>

        {/* Stage toggles */}
        <Card>
          <CardHeader className="border-b border-border py-4 px-5">
            <CardTitle className="card-title">Stages</CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            {(
              [
                ["dedup_enabled", "Deduplicate", "Remove duplicate documents (exact)."],
                ["quality_enabled", "Quality filter", "Prune low-quality documents."],
                ["pii_enabled", "PII redact", "Detect and redact personal data."],
              ] as const
            ).map(([name, label, help]) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>{label}</FormLabel>
                      <FormDescription>{help}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            ))}
            {showHints && (
              <p className="text-xs text-muted-foreground">
                Recommended: all three stages on — a sound, cheap default run.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Stage options */}
        <Card>
          <CardHeader className="border-b border-border py-4 px-5">
            <CardTitle className="card-title">Stage options</CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-6">
            <FormField
              control={form.control}
              name="dedup_mode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dedup mode</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!dedupOn}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full sm:w-96">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEDUP_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showHints && (
                    <FormDescription>Recommended: Exact (CPU).</FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="quality_preset"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Quality preset</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!qualityOn}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full sm:w-80">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {QUALITY_PRESET_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showHints && (
                    <FormDescription>Recommended: Standard.</FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pii_entities"
              render={() => (
                <FormItem>
                  <FormLabel>PII entities</FormLabel>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {PII_ENTITY_OPTIONS.map((entity) => (
                      <FormField
                        key={entity.value}
                        control={form.control}
                        name="pii_entities"
                        render={({ field }) => {
                          const checked = field.value.includes(entity.value);
                          return (
                            <FormItem className="flex flex-row items-center gap-2 space-y-0">
                              <FormControl>
                                <Checkbox
                                  disabled={!piiOn}
                                  checked={checked}
                                  onCheckedChange={(value) => {
                                    const next = value
                                      ? [...field.value, entity.value]
                                      : field.value.filter(
                                          (v: PiiEntity) => v !== entity.value,
                                        );
                                    field.onChange(next);
                                  }}
                                />
                              </FormControl>
                              <FormLabel className="font-normal">
                                {entity.label}
                              </FormLabel>
                            </FormItem>
                          );
                        }}
                      />
                    ))}
                  </div>
                  {showHints && (
                    <FormDescription>
                      Recommended: Email, Phone, Person, US SSN.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="redaction_mode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Redaction mode</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!piiOn}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full sm:w-80">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {REDACTION_MODE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showHints && (
                    <FormDescription>
                      Recommended: Replace with tag.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Working..." : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}
