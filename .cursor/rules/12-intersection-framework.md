# Intersection Framework

## Concept

The **Intersection Framework** enables creation of composite entities by combining multiple entity types with defined relationships and precedence rules.

## Use Cases

- Investor-Manager Relationship: Link fund investors to fund managers
- Deal-Entity Association: Connect deals toMultiple entities
- Geographic Coverage: Link entities to countries/regions
- Risk Classification: Combine entities with risk factors

## Architecture

```
Intersection Type (Definition)
├── Code: "INVESTOR_MANAGER"
├── Members: [Investor, Manager]
└── Member Roles: [investor, manager]

Intersection Instance (Actual Data)
├── Intersection Code: "INV-ABC-MGR-XYZ"
├── Members: {entity_id, role: "investor"}
│           {entity_id, role: "manager"}
└── Attributes: {weight: 50, commitment: 1000000}
```