"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setActivityCompletion } from "@/app/_lib/queries";

/**
 * Closes a pending follow-up.
 *
 * The UPDATE carries `AND is_completed IS NOT NULL`, so a row whose completion marker is
 * "not applicable" can never be flipped to completed by this button. It was never pending
 * and it was never in this queue.
 */
export async function markDoneAction(formData: FormData): Promise<void> {
  const entryId = formData.get("entry_id");
  const back = formData.get("back");

  if (typeof entryId === "string" && entryId !== "") {
    await setActivityCompletion(entryId, true);
  }

  revalidatePath("/follow-ups");
  redirect(typeof back === "string" && back.startsWith("/follow-ups") ? back : "/follow-ups");
}
