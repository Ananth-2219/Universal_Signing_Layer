// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Non-upgradeable, native-only session account. Owner consent can call arbitrary targets.
contract MandateAccount is EIP712, ReentrancyGuard {
    struct EIP712ChainDomain {
        uint256 chainId;
        address verifyingContract;
    }

    struct MandateGrant {
        EIP712ChainDomain domain;
        address sessionKey;
        uint256 perTxLimit;
        uint256 budget;
        uint256 windowSeconds;
        uint256 expiry;
    }

    struct Session {
        uint256 perTxLimit;
        uint256 budget;
        uint256 windowSeconds;
        uint256 expiry;
        uint256 windowStart;
        uint256 spent;
        bool active;
    }

    struct Operation {
        address to;
        uint256 value;
        uint256 nonce;
        uint256 deadline;
    }

    error InvalidOwner();
    error InvalidSessionKey();
    error InvalidWindow();
    error NotOwner();
    error WrongChain();
    error WrongAccount();
    error DeadlinePassed();
    error SessionExpired();
    error MandateNonceUsed();
    error OperationNonceUsed();
    error ConsentNonceUsed();
    error RevokeNonceUsed();
    error SessionAlreadyActive();
    error SessionNotActive();
    error InvalidEnvelope();
    error WrongMagic();
    error WrongFields();
    error InvalidStructIndex();
    error WrongApplication();
    error GrantHashMismatch();
    error InvalidSignature();
    error WrongSigner();
    error PerTxLimitExceeded();
    error BudgetExceeded();
    error InvalidWindowTime();
    error InsufficientBalance();
    error CallFailed();

    event MandateRegistered(address sessionKey, uint256 mandateId, uint256 expiry);
    event SessionRevoked(address sessionKey);
    event Executed(address sessionKey, address to, uint256 value);
    event ConsentExecuted(address to, uint256 value, uint256 nonce);

    address public immutable owner;
    mapping(uint256 => bool) public mandateIdUsed;
    mapping(address => mapping(uint256 => bool)) public operationNonceUsed;
    mapping(address => Session) private _sessions;
    mapping(address => bool) private _windowStarted;
    mapping(uint256 => bool) private _consentNonceUsed;
    mapping(uint256 => bool) private _revokeNonceUsed;

    bytes9 private constant MAGIC = 0x796479647964796479;
    bytes32 private constant CHAIN_TYPEHASH = keccak256("EIP712ChainDomain(uint256 chainId,address verifyingContract)");
    bytes32 private constant GRANT_TYPEHASH = keccak256(
        "MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)EIP712ChainDomain(uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant MANDATE_TYPEHASH = keccak256(
        "Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)EIP712ChainDomain(uint256 chainId,address verifyingContract)MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)"
    );
    bytes32 private constant OPERATION_TYPEHASH =
        keccak256("Operation(address to,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant CONSENT_TYPEHASH =
        keccak256("Consent(address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    bytes32 private constant REVOKE_TYPEHASH =
        keccak256("RevokeSession(address sessionKey,uint256 nonce,uint256 deadline)");
    bytes32 private constant CHAINLESS_DOMAIN = keccak256(
        abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("USLMandate"), keccak256("1"))
    );

    constructor(address owner_) EIP712("USLMandate", "1") {
        if (owner_ == address(0)) revert InvalidOwner();
        owner = owner_;
    }

    function sessions(address sessionKey) external view returns (Session memory) {
        return _sessions[sessionKey];
    }

    function registerMandate(MandateGrant calldata grant, uint256 nonce, uint256 deadline, bytes calldata envelope)
        external
        nonReentrant
    {
        if (grant.domain.chainId != block.chainid) revert WrongChain();
        if (grant.domain.verifyingContract != address(this)) revert WrongAccount();
        _checkDeadline(deadline);
        if (grant.expiry <= block.timestamp) revert SessionExpired();
        if (grant.sessionKey == address(0)) revert InvalidSessionKey();
        // A zero window would reset the budget on every spend, silently removing the budget limit.
        if (grant.windowSeconds == 0) revert InvalidWindow();
        if (mandateIdUsed[nonce]) revert MandateNonceUsed();
        if (_sessions[grant.sessionKey].active) revert SessionAlreadyActive();

        (bytes32 header, bytes32[] memory hashes, bytes memory signature) = _decodeEnvelope(envelope);
        if (bytes9(header) != MAGIC) revert WrongMagic();
        if (uint8(uint256(header) >> 176) != 0x03) revert WrongFields();
        uint256 index = uint16(uint256(header) >> 160);
        if (index >= hashes.length) revert InvalidStructIndex();
        if (address(uint160(uint256(header))) != address(this)) revert WrongApplication();
        // Rebuild from local context and the actual grant, never just the supplied hash.
        bytes32 grantHash = keccak256(
            abi.encode(
                GRANT_TYPEHASH,
                keccak256(abi.encode(CHAIN_TYPEHASH, block.chainid, address(this))),
                grant.sessionKey,
                grant.perTxLimit,
                grant.budget,
                grant.windowSeconds,
                grant.expiry
            )
        );
        if (hashes[index] != grantHash) revert GrantHashMismatch();
        bytes32 structHash =
            keccak256(abi.encode(MANDATE_TYPEHASH, keccak256(abi.encodePacked(hashes)), nonce, deadline));
        _checkOwner(MessageHashUtils.toTypedDataHash(CHAINLESS_DOMAIN, structHash), signature);

        // Consume the exact signed ID after verification, never a changed counter.
        mandateIdUsed[nonce] = true;
        _sessions[grant.sessionKey] =
            Session(grant.perTxLimit, grant.budget, grant.windowSeconds, grant.expiry, 0, 0, true);
        _windowStarted[grant.sessionKey] = false;
        // Do not clear operationNonceUsed: old executed operations must stay unusable after renewal.
        emit MandateRegistered(grant.sessionKey, nonce, grant.expiry);
    }

    function executeWithSessionSig(Operation calldata op, bytes calldata signature) external nonReentrant {
        address signer = _recover(
            _hashTypedDataV4(keccak256(abi.encode(OPERATION_TYPEHASH, op.to, op.value, op.nonce, op.deadline))),
            signature
        );
        Session storage session = _sessions[signer];
        if (!session.active) revert SessionNotActive();
        _checkDeadline(op.deadline);
        if (session.expiry <= block.timestamp) revert SessionExpired();
        if (operationNonceUsed[signer][op.nonce]) revert OperationNonceUsed();
        if (op.value > session.perTxLimit) revert PerTxLimitExceeded();
        if (block.timestamp < session.windowStart) revert InvalidWindowTime();
        // Subtraction implements now >= start + duration without uint256 addition overflow.
        if (!_windowStarted[signer] || block.timestamp - session.windowStart >= session.windowSeconds) {
            session.windowStart = block.timestamp;
            session.spent = 0;
            _windowStarted[signer] = true;
        }
        if (session.spent > session.budget || op.value > session.budget - session.spent) revert BudgetExceeded();
        operationNonceUsed[signer][op.nonce] = true;
        session.spent += op.value;
        // All effects precede the call; a failed call reverts spending and nonce use too.
        _call(op.to, op.value, "");
        emit Executed(signer, op.to, op.value);
    }

    function executeWithConsent(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes calldata ownerSignature
    ) external nonReentrant {
        _checkDeadline(deadline);
        if (_consentNonceUsed[nonce]) revert ConsentNonceUsed();
        _checkOwner(
            _hashTypedDataV4(keccak256(abi.encode(CONSENT_TYPEHASH, to, value, keccak256(data), nonce, deadline))),
            ownerSignature
        );
        _consentNonceUsed[nonce] = true;
        _call(to, value, data);
        emit ConsentExecuted(to, value, nonce);
    }

    function revokeSession(address sessionKey) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        _revoke(sessionKey);
    }

    function revokeSessionWithSig(address sessionKey, uint256 nonce, uint256 deadline, bytes calldata ownerSignature)
        external
        nonReentrant
    {
        _checkDeadline(deadline);
        if (_revokeNonceUsed[nonce]) revert RevokeNonceUsed();
        _checkOwner(
            _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, sessionKey, nonce, deadline))), ownerSignature
        );
        _revokeNonceUsed[nonce] = true;
        _revoke(sessionKey);
    }

    function _revoke(address sessionKey) private {
        if (!_sessions[sessionKey].active) revert SessionNotActive();
        _sessions[sessionKey].active = false;
        emit SessionRevoked(sessionKey);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlinePassed();
    }

    function _checkOwner(bytes32 digest, bytes memory signature) private view {
        if (_recover(digest, signature) != owner) revert WrongSigner();
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        ECDSA.RecoverError err;
        (signer, err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer == address(0)) revert InvalidSignature();
    }

    function _call(address to, uint256 value, bytes memory data) private {
        if (value > address(this).balance) revert InsufficientBalance();
        (bool ok,) = to.call{value: value}(data);
        if (!ok) revert CallFailed();
    }

    function _decodeEnvelope(bytes calldata encoded)
        private
        pure
        returns (bytes32 header, bytes32[] memory hashes, bytes memory signature)
    {
        // Validate canonical bounds before abi.decode so malformed input uses our custom error.
        uint256 length = encoded.length;
        if (length < 160 || length % 32 != 0) revert InvalidEnvelope();
        uint256 arrayOffset;
        uint256 signatureOffset;
        uint256 count;
        assembly ("memory-safe") {
            arrayOffset := calldataload(add(encoded.offset, 32))
            signatureOffset := calldataload(add(encoded.offset, 64))
            count := calldataload(add(encoded.offset, 96))
        }
        if (arrayOffset != 96 || count == 0 || count > (length - 160) / 32) revert InvalidEnvelope();
        if (signatureOffset != 128 + count * 32) revert InvalidEnvelope();
        uint256 signatureLength;
        assembly ("memory-safe") { signatureLength := calldataload(add(encoded.offset, signatureOffset)) }
        uint256 available = length - signatureOffset - 32;
        if (signatureLength > available || available - signatureLength != (32 - signatureLength % 32) % 32) {
            revert InvalidEnvelope();
        }
        (header, hashes, signature) = abi.decode(encoded, (bytes32, bytes32[], bytes));
        if (keccak256(encoded) != keccak256(abi.encode(header, hashes, signature))) revert InvalidEnvelope();
    }

    receive() external payable {}
}
