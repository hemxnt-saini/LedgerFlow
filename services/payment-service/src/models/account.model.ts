/**
 * The accounts table, and the shape the API hands out.
 *
 * Rows are snake_case because that is what Postgres returns; DTOs are
 * camelCase because that is what the wire speaks. Keeping the translation in
 * one function means no route has to remember which convention it is holding.
 */
export interface AccountRow {
  id: string;
  name: string;
  balance_cents: number;
  is_system: boolean;
  created_at: Date;
}

export interface AccountDto {
  id: string;
  name: string;
  balanceCents: number;
  isSystem: boolean;
  createdAt: Date;
}

export const toAccountDto = (row: AccountRow): AccountDto => ({
  id: row.id,
  name: row.name,
  balanceCents: row.balance_cents,
  isSystem: row.is_system,
  createdAt: row.created_at,
});
