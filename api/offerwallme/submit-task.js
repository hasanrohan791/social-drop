package com.socialdrop.app.data.models

import com.google.gson.annotations.SerializedName

/**
 * Live Admin Configuration for Offerwall Tasks from Firestore path: settings/offerwall
 */
data class OfferwallSettings(
    val taskSystemEnabled: Boolean = true,
    val userRewardPercentage: Double = 80.0,
    val rewardRatio: Double = 0.80
) {
    fun calculateUserReward(task: OfferwallTask): Double {
        val grossPayout = when {
            task.payout != null && task.payout > 0.0 -> task.payout
            task.reward > 0.0 -> task.reward
            else -> 0.0
        }
        val effectiveRatio = if (rewardRatio > 0.0) rewardRatio else (userRewardPercentage / 100.0)
        return grossPayout * effectiveRatio
    }
}

/**
 * Offerwall.me Task Model representing real task fields from Vercel Backend / Offerwall.me API.
 */
data class OfferwallTask(
    @SerializedName("id") val id: String = "",
    @SerializedName("taskId") val taskId: String? = null,
    @SerializedName("title") val title: String = "",
    @SerializedName("translatedTitle") val translatedTitle: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("translatedDescription") val translatedDescription: String? = null,
    @SerializedName("instructions") val instructions: String? = null,
    @SerializedName("translatedInstructions") val translatedInstructions: String? = null,
    @SerializedName("instructionImageUrl") val instructionImageUrl: String? = null,
    @SerializedName("imageUrl") val imageUrl: String? = null,
    @SerializedName("reward") val reward: Double = 0.0,            // User's net reward in Taka (৳)
    @SerializedName("payout") val payout: Double? = null,           // Raw provider payout
    @SerializedName("coins") val coins: Int? = null,
    @SerializedName("estimatedMinutes") val estimatedMinutes: Int? = null,
    @SerializedName("category") val category: String? = null,
    @SerializedName("url") val url: String? = null,                 // Destination URL / task link
    @SerializedName("link") val link: String? = null,
    @SerializedName("status") val status: String? = "available",
    @SerializedName("requiresProof") val requiresProof: Boolean = true,
    @SerializedName("proofType") val proofType: String? = "text",   // "text" or "image"
    @SerializedName("isSensitive") val isSensitive: Boolean? = false,
    @SerializedName("isRepeatable") val isRepeatable: Boolean? = false
) {
    fun getEffectiveId(): String = if (id.isNotBlank()) id else (taskId ?: "")
    fun getEffectiveUrl(): String = if (!url.isNull_or_blank_safe()) url!! else (link ?: "")
    fun getEffectiveInstructionImage(): String = if (!instructionImageUrl.isNull_or_blank_safe()) instructionImageUrl!! else (imageUrl ?: "")
}

private fun String?.isNull_or_blank_safe(): Boolean = this == null || this.trim().isEmpty()

/**
 * User Task Submission Record.
 */
data class OfferwallTaskSubmission(
    @SerializedName("id") val id: String? = null,
    @SerializedName("taskId") val taskId: String = "",
    @SerializedName("taskTitle") val taskTitle: String? = null,
    @SerializedName("reward") val reward: Double = 0.0,
    @SerializedName("proofText") val proofText: String? = null,
    @SerializedName("proofImageUrl") val proofImageUrl: String? = null,
    @SerializedName("status") val status: String = "pending",      // "pending", "approved", "rejected", "reversed"
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("submittedAt") val submittedAt: String? = null,
    @SerializedName("adminNote") val adminNote: String? = null
)

/**
 * API Response for GET /api/offerwallme/tasks
 */
data class OfferwallTasksResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("message") val message: String? = null,
    @SerializedName("tasks") val tasks: List<OfferwallTask>? = null,
    @SerializedName("submissions") val submissions: List<OfferwallTaskSubmission>? = null,
    @SerializedName("error") val error: String? = null
)

/**
 * Request payload for POST /api/offerwallme/submit-task
 */
data class SubmitOfferwallTaskRequest(
    @SerializedName("taskId") val taskId: String,
    @SerializedName("proof") val proof: String,
    @SerializedName("proofText") val proofText: String? = null,
    @SerializedName("proofImageBase64") val proofImageBase64: String? = null
)

/**
 * API Response for POST /api/offerwallme/submit-task
 */
data class SubmitOfferwallTaskResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("message") val message: String? = null,
    @SerializedName("messageBn") val messageBn: String? = null,
    @SerializedName("error") val error: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("submissionId") val submissionId: String? = null,
    @SerializedName("walletCredited") val walletCredited: Boolean = false
) {
    fun isSuccessfulResponse(): Boolean {
        if (success) return true
        if (!messageBn.isNull_or_blank_safe()) return true
        val st = (status ?: "").trim().lowercase()
        val msg = (message ?: "").trim().lowercase()
        return st in listOf("success", "ok", "approved", "pending", "submitted") ||
               msg.contains("success") || msg.contains("submitted") || !submissionId.isNull_or_blank_safe()
    }
}
