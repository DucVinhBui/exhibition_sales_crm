"use server";

/**
 * Opening a new enquiry for an exhibitor.
 *
 * This is the one place the CRM creates a row rather than amending one, and the rules it
 * enforces are the same ones the importer lives by:
 *
 *   * An empty field is stored as NULL -- unknown -- and never as 0. A brand-new enquiry
 *     usually has no figure attached yet, and inventing one would put a number in front of
 *     technical that nobody ever said.
 *   * Nothing is validated against the edition's height limit here, because nothing about
 *     the stand is asked for here. The brief is filled in afterwards on the enquiry page,
 *     where an over-limit request is recorded as asked and flagged at read time.
 *   * The chosen contact must belong to THIS exhibitor. A contact id arriving from a
 *     hand-edited form is checked against the company's own list rather than trusted.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getCompanyByCode,
  getCompanyContacts,
  insertOpportunity,
  listFairEditions,
} from "@/app/_lib/queries";
import { parseDateInput, parseDecimalInput } from "@/app/_lib/input";
import type { Id } from "@/db/schema";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function back(code: string, params: Record<string, string>): never {
  redirect(`/companies/${encodeURIComponent(code)}?${new URLSearchParams(params).toString()}`);
}

export async function createEnquiryAction(formData: FormData): Promise<void> {
  const code = field(formData, "company_code");
  if (code === "") redirect("/");

  const company = await getCompanyByCode(code);
  if (company === null) back(code, { error: "That exhibitor no longer exists." });

  const description = field(formData, "description").trim();
  if (description === "") {
    back(code, { error: "Give the enquiry a description — a list of untitled enquiries helps nobody." });
  }

  const editions = await listFairEditions();
  const edition = editions.find((option) => String(option.id) === field(formData, "fair_edition_id"));
  if (edition === undefined) {
    back(code, { error: "Choose the fair edition this enquiry is for." });
  }

  // "" means none chosen, which is legitimate: an enquiry can arrive before anyone knows who
  // at the exhibitor is running it. A non-empty value must be one of this company's contacts.
  const contactRaw = field(formData, "contact_id");
  let contactId: Id | null = null;
  if (contactRaw !== "") {
    const contacts = await getCompanyContacts(company.id);
    const contact = contacts.find((row) => String(row.id) === contactRaw);
    if (contact === undefined) {
      back(code, { error: "That contact does not belong to this exhibitor." });
    }
    contactId = contact.id;
  }

  const openedOn = parseDateInput(field(formData, "opened_on"), "Opened on");
  if (!openedOn.ok) back(code, { error: openedOn.error });
  if (openedOn.value === null) back(code, { error: "When was this enquiry opened?" });

  const amount = parseDecimalInput(field(formData, "amount_eur"), {
    label: "Opportunity value",
    precision: 12,
    scale: 2,
  });
  if (!amount.ok) back(code, { error: amount.error });

  const opportunityCode = await insertOpportunity({
    company_id: company.id,
    contact_id: contactId,
    fair_edition_id: edition.id,
    description,
    amount_eur: amount.value,
    opened_on: openedOn.value,
    brief_notes: field(formData, "brief_notes").trim(),
  });

  revalidatePath(`/companies/${code}`);
  revalidatePath(`/opportunities/${opportunityCode}`);
  // Straight to the new enquiry: the brief, the conversation log and the assistant all live
  // there, and that is where the operator was heading anyway.
  redirect(`/opportunities/${encodeURIComponent(opportunityCode)}?saved=created`);
}
