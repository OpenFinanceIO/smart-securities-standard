pragma solidity ^0.5.0;

import { DelegatedERC20 } from "./interfaces/DelegatedERC20.sol";

import { ERC20Detailed } from "./zeppelin-solidity/contracts/token/ERC20/ERC20Detailed.sol";
import { Ownable } from "./zeppelin-solidity/contracts/ownership/Ownable.sol";

/**
 * @title TokenFront is intended to provide a permanent address for a
 * restricted token.  Systems which intend to use the token front should not
 * emit ERC20 events.  Rather this contract should emit them. 
 */
contract TokenFront is ERC20Detailed, Ownable {

    DelegatedERC20 public tokenLogic;
    
    constructor(
        DelegatedERC20 _tokenLogic, 
        address _owner, 
        string memory name, 
        string memory symbol, 
        uint8 decimals
    ) public ERC20Detailed(name, symbol, decimals) {
        tokenLogic = _tokenLogic; 
        _transferOwnership(_owner);
    }

    function migrate(DelegatedERC20 newTokenLogic) public onlyOwner {
        tokenLogic = newTokenLogic;
    }

    function allowance(address owner, address spender) 
        public 
        view 
        returns (uint256)
    {
        return tokenLogic.allowance(owner, spender);
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        if (tokenLogic.transferFrom(from, to, value, msg.sender)) {
            emit Transfer(from, to, value);
            return true;
        } 
        return false;
    }

    function approve(address spender, uint256 value) public returns (bool) {
        if (tokenLogic.approve(spender, value, msg.sender)) {
            emit Approval(msg.sender, spender, value);
            return true;
        }
        return false;
    }

    function totalSupply() public view returns (uint256) {
        return tokenLogic.totalSupply();
    }
    
    function balanceOf(address who) public view returns (uint256) {
        return tokenLogic.balanceOf(who);
    }

    function transfer(address to, uint256 value) public returns (bool) {
        if (tokenLogic.transfer(to, value, msg.sender)) {
            emit Transfer(msg.sender, to, value);
            return true;
        } 
        return false;
    }

}
