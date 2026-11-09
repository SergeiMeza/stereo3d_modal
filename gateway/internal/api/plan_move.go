package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"cloud.google.com/go/firestore"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// RP-05 (owner 2026-11-06): support moves a web plan off a live account,
// after a manual check of who owns it. Never self-service: only an admin
// offers a move, and only the receiving account accepts it.
//
//   - POST /v1/admin/cases {uid: from, reason: "plan_move", text}: a
//     manual support case; text (how ownership was checked) is required.
//   - GET /v1/admin/cases/{id}/plan-move/preview?to={uid} → {from_uid,
//     to_uid, plan, plan_id, subscription_id, period_end, renews, moves,
//     stays, carry_cents, blockers}. Blockers: same_account, no_plan,
//     plan_renewing, target_has_plan, target_missing, from_deleted,
//     move_open.
//   - POST /v1/admin/cases/{id}/actions {action: "offer_plan_move",
//     to_uid, expected_subscription_id} (a money action: a passkey within
//     5 minutes): a pending move, single use, for 7 days; nothing moves.
//     {action: "cancel_plan_move"} withdraws it.
//   - GET /v1/support/plan-moves → {moves: [{id, plan, plan_id, ends_at,
//     from, moves, stays, carry_cents, expires_at}]} for the receiving
//     account; POST /v1/support/plan-moves/{id}/accept (fresh sign-in) →
//     {moved, plan}. 409 the blockers again; 410 move_expired; 404
//     move_not_found.
//
// The accept re-points the subscription (metadata user_id = to,
// moved_from = from, key move_{env}_{sub}_{to}; it stays on the old
// Stripe customer and is never cancelled), moves the plan in one
// transaction (the old account keeps plan_moved_to), revokes the app's
// entitlements there and grants them here to the period's end plus 72 h,
// and carries the current credit once (the never-twice rules of
// Restore). A moved plan never renews (planNotRenewable).

const ReasonPlanMove = "plan_move"

// planMoveRenewing is the open owner question for a plan that still
// renews: "refuse" (the default: we never cancel plans on our own) or
// "end" (set it to end at the period's end as part of the move).
var planMoveRenewing = "refuse"

var planMoveStays = []string{"usage_already_used", "balance", "app_store_purchases", "admin_grants", "past_runs_and_files"}

// planMoveCheck reads both accounts and lists what blocks a move.
func (s *Service) planMoveCheck(ctx context.Context, from, to string) (*store.Customer, *store.Customer, []string) {
	blockers := []string{}
	fc, err := s.Store.GetCustomer(ctx, from)
	now := time.Now().UTC()
	if err != nil || fc.Plan == nil || fc.Plan.SubscriptionID == "" || !fc.Plan.Active(now) {
		blockers = append(blockers, "no_plan")
		fc = nil
	}
	if to == "" || to == from {
		blockers = append(blockers, "same_account")
	}
	if fc != nil {
		if fc.AccountDeleted {
			blockers = append(blockers, "from_deleted") // Restore Purchases covers a deleted account
		}
		if planMoveRenewing == "refuse" && !fc.Plan.CancelAtPeriodEnd {
			blockers = append(blockers, deleteBlockPlanRenewing)
		}
		if m, err := s.Store.GetPlanMove(ctx, fc.Plan.SubscriptionID); err == nil &&
			(m.State == store.PlanMoveAccepted || (m.State == store.PlanMoveOffered && now.Before(m.ExpiresAt))) {
			blockers = append(blockers, "move_open")
		}
	}
	var tc *store.Customer
	if to != "" && to != from {
		if ok, err := s.userExists(ctx, to); err != nil || !ok {
			blockers = append(blockers, "target_missing")
		}
		if c, err := s.Store.GetCustomer(ctx, to); err == nil {
			tc = c
			if c.AccountDeleted || c.DeletionPending {
				blockers = append(blockers, "target_missing")
			}
			sub := ""
			if fc != nil {
				sub = fc.Plan.SubscriptionID
			}
			if hasOwnPlan(c, sub, now) {
				blockers = append(blockers, "target_has_plan")
			}
		}
	}
	return fc, tc, blockers
}

// planCarry is the unspent, unfrozen credit of uid's current plan period.
func (s *Service) planCarry(ctx context.Context, uid string, now time.Time) (int64, *time.Time) {
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil {
		return 0, nil
	}
	var cents int64
	var exp *time.Time
	for _, it := range b.Fifo {
		if !it.PlanCredit || it.ExpiresAt == nil || !it.ExpiresAt.After(now) {
			continue
		}
		if left := it.RemainingCents - it.FrozenCents; left > 0 {
			cents += left
			if exp == nil || it.ExpiresAt.After(*exp) {
				e := *it.ExpiresAt
				exp = &e
			}
		}
	}
	return cents, exp
}

func planMoveMoves(p *store.Plan, carry int64) []string {
	moves := []string{"plan", "app_access"}
	if carry > 0 {
		moves = append(moves, "current_usage")
	}
	if p.Yearly() {
		moves = append(moves, "months_not_yet_given")
	}
	return moves
}

func errPlanMoveBlocked(blockers []string) *httpx.APIError {
	words := map[string]string{
		"same_account":          "That's the same account.",
		"no_plan":               "The account has no web plan to move.",
		deleteBlockPlanRenewing: "The plan still renews. The customer cancels it first; it then moves until its end.",
		"target_has_plan":       "The receiving account has a plan of its own.",
		"target_missing":        "The receiving account doesn't exist or is being deleted.",
		"from_deleted":          "The account is deleted: the customer uses Restore Purchases instead.",
		"move_open":             "A move of this plan is already open.",
	}
	e := httpx.Err(http.StatusConflict, blockers[0], words[blockers[0]])
	e.Details = map[string]any{"blockers": blockers}
	return e
}

// HandleAdminPlanMovePreview is GET /v1/admin/cases/{id}/plan-move/preview.
func (s *Service) HandleAdminPlanMovePreview(w http.ResponseWriter, r *http.Request, a *AdminUser, id string) {
	ctx := r.Context()
	c, err := s.Store.GetCase(ctx, id)
	if err != nil || c.Reason != ReasonPlanMove {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("plan move case"))
		return
	}
	to := strings.TrimSpace(r.URL.Query().Get("to"))
	fc, _, blockers := s.planMoveCheck(ctx, c.UID, to)
	out := map[string]any{"from_uid": c.UID, "to_uid": to, "blockers": blockers, "stays": planMoveStays}
	if fc != nil {
		p := fc.Plan
		carry, _ := s.planCarry(ctx, c.UID, time.Now().UTC())
		out["plan"], out["plan_id"], out["subscription_id"] = p.Tier, p.Key(), p.SubscriptionID
		out["period_end"], out["renews"], out["carry_cents"] = p.CurrentPeriodEnd, !p.CancelAtPeriodEnd, carry
		out["moves"] = planMoveMoves(p, carry)
	}
	s.audit(ctx, a, "plan_move_preview", map[string]any{"case_id": id, "to_uid": to, "blockers": blockers})
	httpx.WriteOK(w, out)
}

// offerPlanMove is the offer_plan_move action.
func (s *Service) offerPlanMove(ctx context.Context, c *store.Case, req caseActionReq, who string) error {
	to := strings.TrimSpace(req.ToUID)
	fc, _, blockers := s.planMoveCheck(ctx, c.UID, to)
	if len(blockers) > 0 {
		return errPlanMoveBlocked(blockers)
	}
	p := fc.Plan
	if req.ExpectedSubscriptionID == "" || req.ExpectedSubscriptionID != p.SubscriptionID {
		e := httpx.Err(http.StatusConflict, "subscription_changed", "The account's plan changed. Look at the preview again.")
		e.Details = map[string]any{"subscription_id": p.SubscriptionID}
		return e
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return err
	}
	moveID := "pm_" + hex.EncodeToString(raw[:])
	now := time.Now().UTC()
	m := &store.PlanMove{ID: p.SubscriptionID, MoveID: moveID, TokenHash: store.MoveTokenHash(moveID), CaseID: c.ID, FromUID: c.UID, ToUID: to,
		Plan: p.Tier, PlanID: p.PlanID, PeriodEnd: *p.CurrentPeriodEnd, State: store.PlanMoveOffered, OfferedBy: who, OfferedAt: now,
		ExpiresAt: now.Add(store.PlanMoveTTL)}
	if err := s.Store.OfferPlanMove(ctx, m, now); err != nil {
		if errors.Is(err, store.ErrMoveBusy) || errors.Is(err, store.ErrRestoredElsewhere) {
			return errPlanMoveBlocked([]string{"move_open"})
		}
		return err
	}
	if _, err := s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
		x.PlanMove = &store.CasePlanMove{FromUID: c.UID, ToUID: to, SubscriptionID: p.SubscriptionID, Plan: p.Tier, PeriodEnd: m.PeriodEnd,
			State: store.PlanMoveOffered, TokenHash: m.TokenHash, OfferedBy: who, OfferedAt: now, ExpiresAt: m.ExpiresAt}
		return nil
	}); err != nil {
		return err
	}
	return s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "plan_move_offered", Text: req.Text,
		Data: map[string]any{"to_uid": to, "plan": p.Tier, "expires_at": m.ExpiresAt}})
}

// cancelPlanMove is the cancel_plan_move action.
func (s *Service) cancelPlanMove(ctx context.Context, c *store.Case, req caseActionReq, who string) error {
	if c.PlanMove == nil {
		return httpx.Err(http.StatusConflict, "no_move", "No move was offered on this case.")
	}
	if err := s.Store.CancelPlanMove(ctx, c.PlanMove.SubscriptionID); err != nil {
		if errors.Is(err, store.ErrMoveInvalid) {
			return httpx.Err(http.StatusConflict, "no_move", "No offer is waiting (accepted, expired or cancelled).")
		}
		return err
	}
	s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
		if x.PlanMove != nil {
			x.PlanMove.State = store.PlanMoveCancelled
		}
		return nil
	})
	return s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "plan_move_cancelled", Text: req.Text})
}

// HandleSupportPlanMoves is GET /v1/support/plan-moves.
func (s *Service) HandleSupportPlanMoves(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	moves, err := s.Store.ListPlanMovesTo(ctx, user.UID, now)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	rows := []map[string]any{}
	for _, m := range moves {
		from := []string{}
		if id, err := s.identityOrNil(ctx, m.FromUID); err == nil && id != nil {
			from = signInMethods(id)
		}
		carry, _ := s.planCarry(ctx, m.FromUID, now)
		p := &store.Plan{Interval: ""}
		if fc, err := s.Store.GetCustomer(ctx, m.FromUID); err == nil && fc.Plan != nil {
			p = fc.Plan
		}
		plan := m.PlanID
		if plan == "" {
			plan = m.Plan
		}
		rows = append(rows, map[string]any{"id": m.MoveID, "plan": m.Plan, "plan_id": plan, "ends_at": m.PeriodEnd.UTC().Format(time.RFC3339),
			"from": from, "moves": planMoveMoves(p, carry), "stays": planMoveStays, "carry_cents": carry,
			"expires_at": m.ExpiresAt.UTC().Format(time.RFC3339)})
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"moves": rows})
}

// HandleSupportPlanMoveAccept is POST /v1/support/plan-moves/{id}/accept.
func (s *Service) HandleSupportPlanMoveAccept(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	now := time.Now().UTC()
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	m, err := s.Store.ClaimPlanMove(ctx, id, user.UID, user.AuthTime, now)
	switch {
	case errors.Is(err, store.ErrMoveExpired):
		s.Store.UpdateCase(ctx, m.CaseID, "system", func(x *store.Case) error {
			if x.PlanMove != nil {
				x.PlanMove.State = store.PlanMoveExpired
			}
			return nil
		})
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusGone, "move_expired", "This offer has expired. Ask support again."))
		return
	case errors.Is(err, store.ErrMoveInvalid), errors.Is(err, store.ErrRestoredElsewhere):
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "move_not_found", "There's no plan waiting for this account."))
		return
	case err != nil:
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if m.State != store.PlanMoveDone {
		if !s.planMoveStarted(ctx, m) { // nothing done yet: the blockers again (the plan may have changed meanwhile)
			if _, _, blockers := s.planMoveCheck(ctx, m.FromUID, user.UID); len(withoutMoveOpen(blockers)) > 0 {
				s.Store.UpdatePlanMove(ctx, m.ID, []firestore.Update{{Path: "state", Value: store.PlanMoveOffered}}) // the offer stays
				httpx.WriteErr(ctx, w, errPlanMoveBlocked(withoutMoveOpen(blockers)))
				return
			}
		}
		if err := s.acceptPlanMove(ctx, user.UID, m, now); err != nil {
			slog.WarnContext(ctx, "plan move not finished", "step", err.Error())
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "move_unavailable", "We couldn't move it right now. Try again in a while."))
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"moved": true, "plan": s.planJSON(ctx, user.UID)})
}

// withoutMoveOpen drops move_open: the claimed move is the open one.
func withoutMoveOpen(bs []string) []string {
	out := []string{}
	for _, b := range bs {
		if b != "move_open" {
			out = append(out, b)
		}
	}
	return out
}

// planMoveStarted: a resumed accept already changed something.
func (s *Service) planMoveStarted(ctx context.Context, m *store.PlanMove) bool {
	if m.CarryPlanned {
		return true
	}
	if sub, err := s.Stripe.GetSubscription(m.ID); err == nil && sub.Metadata["user_id"] == m.ToUID {
		return true
	}
	return false
}

// acceptPlanMove carries an accepted move out; each step is idempotent.
func (s *Service) acceptPlanMove(ctx context.Context, to string, m *store.PlanMove, now time.Time) error {
	if s.Stripe == nil {
		return errors.New("stripe: not configured")
	}
	from := m.FromUID
	sub, err := s.Stripe.SetSubscriptionMetadata(m.ID, map[string]string{"user_id": to, "moved_from": from}, "move_"+s.Cfg.Env+"_"+m.ID+"_"+to)
	if err != nil {
		return errors.New("stripe: metadata")
	}
	fc, err := s.Store.GetCustomer(ctx, from)
	if err != nil {
		return errors.New("customers: the old account")
	}
	// The old account's entitlements go while it still holds the plan.
	if fc.Plan != nil && fc.Plan.SubscriptionID == m.ID {
		s.revokePlanEntitlement(ctx, from, "plan moved to another account")
	}
	// This period's credit: recorded, then taken off the old account, then
	// granted here, once.
	if !m.CarryPlanned {
		cents, exp := s.planCarry(ctx, from, now)
		if err := s.Store.SetPlanMoveCarry(ctx, m.ID, cents, exp); err != nil {
			return errors.New("plan_moves: carry")
		}
		m.CarryPlanned, m.CarryCents, m.CarryExpiresAt = true, cents, exp
	}
	if !m.CarryRemoved {
		s.planCreditOp(ctx, from, store.EntryPlanCreditRemoval, m.ID, m.CaseID, "moved to another account", "plancredit_moved_"+m.ID)
		if err := s.Store.UpdatePlanMove(ctx, m.ID, []firestore.Update{{Path: "carry_removed", Value: true}}); err != nil {
			return errors.New("plan_moves: carry")
		}
	}
	if m.CarryCents > 0 && m.CarryExpiresAt != nil && m.CarryExpiresAt.After(now) {
		entry := "plancredit_move_" + m.ID
		if done, err := s.Store.EntryExists(ctx, to, entry); err != nil {
			return errors.New("balance: read")
		} else if !done {
			exp := *m.CarryExpiresAt
			_, fx, err := s.Store.BalanceTx(ctx, to, func(*store.Balance) ([]store.BalanceOp, error) {
				return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: m.CarryCents, EntryID: entry, Ref: m.ID, ExpiresAt: &exp,
					Note: tierLabel(m.Plan) + " credit carried over (moved)"}}, nil
			})
			if err != nil {
				if done, _ := s.Store.EntryExists(ctx, to, entry); !done {
					return errors.New("balance: carry")
				}
			} else {
				s.handleBalanceEffects(ctx, to, fx)
			}
		}
	}
	// The plan, in one transaction.
	start, end := sub.Period()
	next := &store.Plan{Tier: m.Plan, SubscriptionID: m.ID, Status: sub.Status, CurrentPeriodStart: &start, CurrentPeriodEnd: &end,
		CancelAtPeriodEnd: sub.CancelAtPeriodEnd, UpdatedAt: now, Interval: sub.Interval(), PlanID: m.PlanID, RestoredFrom: from}
	if fc.Plan != nil && fc.Plan.SubscriptionID == m.ID {
		next.LastInvoiceID, next.LastCreditCents, next.StartedAt = fc.Plan.LastInvoiceID, fc.Plan.LastCreditCents, fc.Plan.StartedAt
		next.PeriodPaidCents, next.Intro, next.AppProChecked = fc.Plan.PeriodPaidCents, fc.Plan.Intro, fc.Plan.AppProChecked
		next.CommercialUntil = fc.Plan.CommercialUntil // grandfathered Commercial use moves with the plan
	}
	if err := s.Store.MovePlanBetween(ctx, from, to, m.ID, next, now); err != nil {
		return errors.New("customers: move")
	}
	// The app's entitlements here, to the period's end plus 72 h.
	if m.Plan == pricing.TierBusiness || m.Plan == pricing.TierStudio || m.Plan == pricing.TierPro {
		inv := next.LastInvoiceID
		if inv == "" {
			inv = "move_" + m.ID
		}
		s.grantPlanEntitlements(ctx, to, m.Plan, inv, end)
	}
	if next.Yearly() {
		if def, ok := s.rates(ctx).Plan(m.Plan); ok {
			s.grantPlanMonth(ctx, to, next, def, now)
		}
	}
	done := time.Now().UTC()
	if err := s.Store.UpdatePlanMove(ctx, m.ID, []firestore.Update{{Path: "state", Value: store.PlanMoveDone}, {Path: "done_at", Value: done}}); err != nil {
		return errors.New("plan_moves: done")
	}
	s.Store.UpdateCase(ctx, m.CaseID, "customer", func(x *store.Case) error {
		if x.PlanMove != nil {
			x.PlanMove.State, x.PlanMove.AcceptedAt, x.PlanMove.AuthTime, x.PlanMove.DoneAt = store.PlanMoveDone, m.AcceptedAt, m.AuthTime, &done
		}
		x.Status, x.Result = store.CaseDecided, "plan_moved"
		return nil
	})
	s.Store.AddCaseEvent(ctx, m.CaseID, store.CaseEvent{Who: "customer", Kind: "plan_move_done",
		Data: map[string]any{"to_uid": to, "carry_cents": m.CarryCents}})
	s.closeCase(ctx, m.CaseID, "system", "plan_moved", "the receiving account accepted the move")
	_ = s.Store.Audit(ctx, map[string]any{"admin": "customer", "admin_uid": to, "action": "plan_move_done", "case_id": m.CaseID,
		"from_uid": from, "to_uid": to, "plan": m.Plan})
	if s.Slack != nil {
		s.Slack.Alert(ctx, "plan_moved", fmt.Sprintf("Support moved a %s plan to another account (%s, until %s)",
			tierLabel(m.Plan), m.CaseID, m.PeriodEnd.Format("2006-01-02")))
	}
	slog.InfoContext(ctx, "plan moved by support", "case_id", m.CaseID, "plan", m.Plan, "carry_cents", m.CarryCents)
	return nil
}
