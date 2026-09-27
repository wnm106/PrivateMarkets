# PR & Code Review Guidelines

## Process Overview

```
1. Create Feature Branch
   └─ git checkout -b feature/your-feature-name

2. Make Changes
   └─ Follow patterns in 05-resolvers.md and 09-generic-entity-model.md

3. Run Tests
   └─ npm run test --workspace=@meridian-mdm/api
   └─ npm run test --workspace=@meridian-mdm/web

4. Update Documentation
   └─ Update relevant .cursor/rules files if patterns changed

5. Create Pull Request
   └─ Template below

6. Review & Merge
   └─ Wait for passing CI and approvals
```

## ✅ CRITICAL: Test-Until-Fixed Policy

### When Tests Fail, CURSOR MUST:

1. **Read the error message carefully** - the error tells you exactly what's broken
2. **Review the relevant rule files**:
   - Check `patterns-catalog.md` for the pattern being used
   - Check `test-registry.md` for expected test patterns
   - Check `05-resolvers.md` for resolver structure
3. **Run the failing test with debug info**:
   ```
   npm run test -- --debug
   npm run test -- --reporter=verbose
   ```
4. **Fix the code** - make minimal, targeted changes
5. **Re-run ALL tests for the affected package**:
   ```
   npm run test --workspace=@meridian-mdm/graphql
   ```
6. **Iterate until ALL tests pass** - do not stop until:
   - All tests pass (no failures)
   - All tests pass consistently (re-run if flaky)
   - Code passes type checking
   - Linting passes
7. **Verify manually** - run the app and test the feature

### Golden Rules:
- **Never merge failing tests** - commit suicide if tests fail
- **Keep testing until fixed** - iterate until everything passes
- **If tests fail on CI, fix locally first**
- **If Cursor AI can't fix it, ask for help**

### Test Command Reference:
```
/cursor run tests                    # Run all tests
/cursor run tests --fail-fast       # Stop at first failure
/cursor run tests --coverage        # See which lines aren't tested
/cursor audit patterns              # Check test coverage gaps
```

## PR Template

### Title Format
```
[FEATURE|FIX|CHORE] - Brief description of change

- Module affected: (API|Web|Graphql|UI)
- Issue: (closes #123)
```

### Description Checklist

- [ ] **Problem Statement**: What problem does this solve?
- [ ] **Solution**: How does this solution work?
- [ ] **Screenshots/Logs**: Any relevant outputs
- [ ] **Tests Added**: New tests for new functionality
- [ ] **Tests Passing**: All tests pass locally
- [ ] **Type Checking**: No TypeScript errors
- [ ] **Linting**: No linting errors
- [ ] **Documentation**: Updated if needed

### Breaking Changes

If your PR includes breaking changes, add:
- [ ] Breaking change warning in description
- [ ] Migration guide
- [ ] Version bump to MAJOR (e.g., 1.0.0 → 2.0.0)

## Code Review Checklist

### Architecture
- [ ] Follows Generic Entity Model patterns
- [ ] Uses Golden Record pattern where appropriate
- [ ] Intersection framework used for composite entities
- [ ] No schema drift (resolver matches schema)

### Code Quality
- [ ] Follows existing code patterns
- [ ] Error handling present
- [ ] Context properly used
- [ ] No hardcoded values (use enums/constants)
- [ ] Proper database indexes used

### Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Golden record tests pass
- [ ] Temporal queries tested

### Documentation
- [ ] Schema updated if changed
- [ ] Rules updated if patterns changed
- [ ] README updated if needed

##merged criteria

1. **All tests passing**
2. **Type checking successful**
3. **Code review approved** (at least 1 approval)
4. **CI pipeline successful**
5. **Documentation updated**

## Squash & Merge

PRs should be squash-merged to keep history clean:
- Single commit per PR
- Clear commit message matching PR title
- No merge commits in main branch

## Hotfix Process

1. Create `hotfix/branch-name` from `main`
2. Make minimal changes
3. Skip feature acceptance testing (but run unit tests)
4. Deploy immediately after merging
5. Create release PR for next version