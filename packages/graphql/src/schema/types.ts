// TypeScript types for generic entity model

export interface Entity {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  templateCode?: string;
  templateName?: string;
  description?: string;
  isActive: boolean;
  attributes: Record<string, any>;
  parentRelationships: EntityRelationship[];
  childRelationships: EntityRelationship[];
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface EntityRelationship {
  parentEntityId: string;
  parentEntityCode: string;
  parentEntityName: string;
  parentDomainCode: string;
  childEntityId: string;
  childEntityCode: string;
  childEntityName: string;
  childDomainCode: string;
  relationshipType: string;
  relationshipCode: string;
  isPrimary: boolean;
}

export interface EntityConnection {
  edges: EntityEdge[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface EntityEdge {
  node: Entity;
  cursor: string;
}

export interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
  description?: string;
  isActive: boolean;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
}

// Fund types
export interface Fund {
  id: string;
  entityCode: string;
  entityName: string;
  description?: string;
  isActive: boolean;
  templateId?: string;
  nav?: number;
  navCurrency?: string;
  navDate?: string;
  inceptionDate?: string;
  fundStatus?: string;
  fundType?: string;
  manager?: string;
  aum?: number;
  expenseRatio?: number;
  domicile?: string;
  legalStructure?: string;
  navSource?: string;
  lastUpdated?: string;
  lineage?: any[];
  metadata?: any;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface FundConnection {
  edges: FundEdge[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface FundEdge {
  node: Fund;
  cursor: string;
}

// Issuer types
export interface Issuer {
  id: string;
  entityCode: string;
  entityName: string;
  description?: string;
  isActive: boolean;
  templateId?: string;
  lei?: string;
  country?: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  creditRating?: string;
  website?: string;
  foundedDate?: string;
  employeeCount?: number;
  lastUpdated?: string;
  lineage?: any[];
  metadata?: any;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface IssuerConnection {
  edges: IssuerEdge[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface IssuerEdge {
  node: Issuer;
  cursor: string;
}

